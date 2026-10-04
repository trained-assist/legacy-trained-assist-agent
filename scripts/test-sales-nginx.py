#!/usr/bin/env python3
"""Real isolated nginx smoke for infra/nginx/sales-manager-assistant.conf.

Same technique as test-recruiter-nginx.py: a throwaway nginx instance with the
repo config, a fake GCP upstream behind TLS, and a real chain so
proxy_ssl_verify_depth 3 is exercised. No production paths are touched.

Requires nginx + openssl (nginx is a RU VM dependency; run it there).
"""
import http.client, http.server, os, pathlib, socket, ssl, subprocess, tempfile, threading, time

REPO = pathlib.Path(__file__).resolve().parents[1]
CONFIG = REPO / 'infra/nginx/sales-manager-assistant.conf'


def port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class Upstream(http.server.BaseHTTPRequestHandler):
    # Content-Length on every response: without it nginx answers the client with
    # chunked encoding under proxy_buffering off, and the client's read() waits
    # for a terminator that never comes.
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args): pass

    def _reply(self, body):
        self.send_response(200)
        self.send_header('Content-Type', 'text/plain')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        self.wfile.flush()

    def do_GET(self):
        self._reply((self.path + '|' + self.headers.get('X-Forwarded-Proto', '')).encode())

    def do_POST(self):
        # Echo the body length so the client_max_body_size ceiling is observable.
        self._reply(str(len(self.rfile.read(int(self.headers.get('Content-Length', 0))))).encode())


def build_chain(d):
    """root → intermediate1 → intermediate2 → upstream, chain served leaf-first."""
    def openssl(*args):
        subprocess.run(['openssl', *map(str, args)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', d / 'root.key', '-out', d / 'root.pem',
            '-days', '1', '-subj', '/CN=Test Root', '-addext', 'basicConstraints=critical,CA:TRUE')
    issuer = 'root'
    for name, ca in [('intermediate1', True), ('intermediate2', True), ('upstream', False)]:
        openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', d / (name + '.key'), '-out', d / (name + '.csr'),
                '-subj', '/CN=' + ('localhost' if ca else name))
        (d / (name + '.ext')).write_text(
            'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n' if ca else
            'basicConstraints=critical,CA:FALSE\nsubjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n')
        openssl('x509', '-req', '-in', d / (name + '.csr'), '-CA', d / (issuer + '.pem'), '-CAkey', d / (issuer + '.key'),
                '-CAcreateserial', '-out', d / (name + '.pem'), '-days', '1', '-extfile', d / (name + '.ext'))
        issuer = name
    (d / 'chain.pem').write_text(''.join((d / (n + '.pem')).read_text() for n in ['upstream', 'intermediate2', 'intermediate1']))


def render(d, hp, sp, upstream_port):
    config = CONFIG.read_text()
    config = config.replace('listen 80;', f'listen 127.0.0.1:{hp};')
    config = config.replace('listen 443 ssl;', f'listen 127.0.0.1:{sp} ssl;')
    config = config.replace('/etc/letsencrypt/live/sales-manager-assistant.ru/fullchain.pem', str(d / 'cert.pem'))
    config = config.replace('/etc/letsencrypt/live/sales-manager-assistant.ru/privkey.pem', str(d / 'key.pem'))
    config = config.replace('proxy_pass https://136-65-7-197.sslip.io', f'proxy_pass https://127.0.0.1:{upstream_port}')
    config = config.replace('proxy_ssl_server_name on;',
                            'proxy_ssl_server_name on; proxy_ssl_name localhost; proxy_ssl_session_reuse off;')
    config = config.replace('/etc/ssl/certs/ca-certificates.crt', str(d / 'root.pem'))
    config = config.replace('/var/www/html', str(d / 'webroot'))
    return config


def run():
    with tempfile.TemporaryDirectory(prefix='sales-nginx-') as tmp:
        d = pathlib.Path(tmp)
        hp, sp = port(), port()
        # SAN covers the real names (the point of the wildcard cert) plus the
        # loopback address the client dials, so verification has something valid.
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(d / 'key.pem'),
                        '-out', str(d / 'cert.pem'), '-days', '1', '-subj', '/CN=sales-manager-assistant.ru',
                        '-addext', 'subjectAltName=DNS:sales-manager-assistant.ru,DNS:*.sales-manager-assistant.ru,IP:127.0.0.1'],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        build_chain(d)

        cold = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(str(d / 'chain.pem'), str(d / 'upstream.key'))
        cold.socket = tls.wrap_socket(cold.socket, server_side=True)
        threading.Thread(target=cold.serve_forever, daemon=True).start()

        config = render(d, hp, sp, cold.server_port)
        challenge = d / 'webroot/.well-known/acme-challenge'
        challenge.mkdir(parents=True)
        (challenge / 'probe').write_text('acme-ok')
        # nginx workers drop to an unprivileged user, so a 0700 temp dir (what
        # TemporaryDirectory creates) makes every static file a 404. Real /var/www/html
        # is world-readable; mirror that here instead of running workers as root.
        for path in [d, d / 'webroot', d / 'webroot/.well-known', challenge, challenge / 'probe']:
            os.chmod(path, 0o755)
        (d / 'nginx.conf').write_text(
            f'pid {d}/nginx.pid; error_log {d}/error.log; events {{}} http {{ access_log off; '
            f'client_body_temp_path {d}/body; proxy_temp_path {d}/proxy; {config} }}')
        subprocess.run(['nginx', '-t', '-p', str(d), '-c', str(d / 'nginx.conf')], check=True)
        # Hold the two listen ports until the last possible moment: a released
        # ephemeral port can be handed straight back to the fake upstream below,
        # and nginx then dies on bind() AFTER `nginx -t` passed — the test would
        # hang on a connection to a server that never started.
        held = [socket.socket() for _ in range(2)]
        for sock, want in zip(held, (hp, sp)):
            sock.bind(('127.0.0.1', want))
            sock.listen(1)
        for sock in held:
            sock.close()
        p = subprocess.Popen(['nginx', '-p', str(d), '-c', str(d / 'nginx.conf'), '-g', 'daemon off;'])

        context = ssl.create_default_context(cafile=str(d / 'cert.pem'))

        def request(path, host='sales-manager-assistant.ru', secure=True):
            c = (http.client.HTTPSConnection('127.0.0.1', sp, context=context, timeout=5) if secure
                 else http.client.HTTPConnection('127.0.0.1', hp, timeout=5))
            c.request('GET', path, headers={'Host': host})
            r = c.getresponse()
            data = r.read()
            c.close()
            return r.status, dict(r.getheaders()), data

        def nginx_error_log():
            try:
                return (d / 'error.log').read_text()[-4000:]
            except OSError:
                return '(no error log)'

        try:
            up = False
            for _ in range(100):
                if p.poll() is not None:
                    raise AssertionError('nginx exited during startup:\n' + nginx_error_log())
                try:
                    with socket.create_connection(('127.0.0.1', sp), timeout=.1):
                        up = True
                        break
                except OSError:
                    time.sleep(.02)
            assert up, 'nginx never accepted a connection:\n' + nginx_error_log()

            apex = 'sales-manager-assistant.ru'

            # Apex path form — the pre-subdomain fallback for /s/ and /p/.
            for path in ['/s/rosupack2026/', '/s/rosupack2026/assets/app.css?v=1',
                         '/p/private-report?password=a%2Bb&format=source']:
                s, h, b = request(path)
                assert s == 200 and b.decode() == '/agent' + path + '|https', (s, b)

            # Subdomain form — the subdomain IS the eventKey and lands in /agent/s/<eventKey>/.
            for sub, path, expect in [
                ('rosupack2026', '/', '/agent/s/rosupack2026/|https'),
                ('rosupack2026', '/index.html', '/agent/s/rosupack2026/index.html|https'),
                ('rosupack2026', '/assets/app.css?v=1', '/agent/s/rosupack2026/assets/app.css?v=1|https'),
                ('agroprodmash2026', '/', '/agent/s/agroprodmash2026/|https'),
                ('cpm-autumn-2026', '/hall1.svg', '/agent/s/cpm-autumn-2026/hall1.svg|https'),
            ]:
                s, h, b = request(path, host=f'{sub}.{apex}')
                assert s == 200 and b.decode() == expect, (sub, path, s, b)

            # Any NAME_RE label maps into the mirror namespace — including www,
            # which simply has no sites/ entry and 404s on the GCP side. The
            # invariant that matters is that nothing can reach OUTSIDE sites/,
            # so labels the regex rejects must fall through to the apex.
            for sub in ['www', 'a', 'rosupack-2026', 'x' * 58]:
                s, h, b = request('/index.html', host=f'{sub}.{apex}')
                assert s == 200 and b.decode() == f'/agent/s/{sub}/index.html|https', (sub, s, b)

            # nginx matches a regular-expression server_name case-insensitively AND lowercases
            # the captured label, so an uppercase host lands in the lowercase
            # namespace instead of bypassing NAME_RE on the GCP side. Pinned here
            # because it is the reason no mirror path can be reached with a label
            # GCP would reject; a label nginx cannot match at all falls through to
            # the apex instead.
            for sub in ['UPPER', 'MiXeD']:
                s, h, b = request('/index.html', host=f'{sub}.{apex}')
                assert s == 200 and b.decode() == f'/agent/s/{sub.lower()}/index.html|https', (sub, s, b)

            # A host the regex cannot match falls through to the apex, which is the
            # first TLS server and therefore the default one: identical behaviour to
            # the apex itself, never a mirror path. nginx itself rejects some of
            # them earlier (an empty label is an invalid Host → 400), so the
            # invariant is "not served", not one specific status.
            for bad in ['-lead.' + apex, 'a..b.' + apex, 'rosu_pack.' + apex,
                        'x' * 59 + '.' + apex, apex + '.evil.example']:
                for path in ['/', '/web/login.html']:
                    s, h, b = request(path, host=bad)
                    assert s in (400, 404), (bad, path, s)
                    if s == 404:
                        assert b'<event_key>' in b, (bad, path)

            # The recruiting web app must not be reachable through the sales domain.
            for path in ['/web/login.html', '/hh/review?username=a', '/connect/hh', '/api/hh/proactive/x']:
                s, h, b = request(path)
                assert s == 404 and b'<event_key>' in b, (path, s)

            # Port 80 keeps the subdomain and the query byte-for-byte.
            for host, path in [(apex, '/test?a=b'), ('rosupack2026.' + apex, '/s/x?a=b%20c&d=e+f')]:
                s, h, b = request(path, host=host, secure=False)
                assert s == 308 and h['Location'] == f'https://{host}{path}', (host, s, h.get('Location'))

            s, h, b = request('/.well-known/acme-challenge/probe', secure=False)
            assert s == 200 and b == b'acme-ok'

            # Body limit matches the other public hosts (client_max_body_size 20m).
            for size in [2 * 1024 * 1024, 20 * 1024 * 1024]:
                c = http.client.HTTPSConnection('127.0.0.1', sp, context=context, timeout=30)
                c.request('POST', '/s/rosupack2026/', body=b'x' * size,
                          headers={'Host': 'rosupack2026.' + apex})
                r = c.getresponse()
                assert r.status == 200 and r.read() == str(size).encode(), (size, r.status)
                c.close()
        except Exception:
            print('=== NGINX ERROR LOG ON FAILURE ===')
            print(nginx_error_log())
            raise
        finally:
            p.terminate()
            p.wait(timeout=10)
    print('test-sales-nginx: apex 404-guard, /s/ /p/ proxy, <event_key> subdomain routing, ACME, 20m — OK')


if __name__ == '__main__':
    run()