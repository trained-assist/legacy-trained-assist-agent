// Local OIDC issuer for GCP Workload Identity Federation (#2114 P0.6).
//
// Why this exists: the project's org policy constraints/iam.disableServiceAccountKeyCreation
// forbids service-account keys, and Contabo has no ADC metadata server — so VM2 needs a
// bucket credential that is neither. A federated one: this issuer signs a subject token,
// Google STS verifies it against the JWKS it fetches from this box's public origin, and
// STS hands back an access token scoped to the archive SA.
//
// Three claims STS checks, all of which bit us in turn and are load-bearing:
//   iss — MUST equal the provider's --issuer-uri, else "The issuer in ID Token … does not match"
//   aud — MUST equal the provider's --allowed-audiences
//   sub — becomes the federated principal; the SA grant names it as principalSet/…/subject/<sub>
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ISSUER = process.env.ISSUER || "https://169-58-15-230.sslip.io";
const AUDIENCE = process.env.AUDIENCE
  || "https://iam.googleapis.com/projects/731388616698/locations/global/workloadIdentityPools/ta-vm2/providers/ta-vm2-public";
const SUBJECT = process.env.SUBJECT || "vm2-archive";
const PORT = Number(process.env.PORT || 18080);

const PRIVATE_KEY = fs.readFileSync(path.join(__dirname, "private.pem"), "utf8");
const PUBLIC_KEY = fs.readFileSync(path.join(__dirname, "public.pem"), "utf8");

const JWKS = (() => {
  const { n, e } = crypto.createPublicKey(PUBLIC_KEY).export({ format: "jwk" });
  return { keys: [{ kty: "RSA", use: "sig", alg: "RS256", kid: "vm2-archive", n, e }] };
})();

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function signJwt(payload) {
  const header = { alg: "RS256", typ: "JWT", kid: "vm2-archive" };
  const now = Math.floor(Date.now() / 1000);
  const claims = { ...payload, iat: now, exp: now + 3600 };
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = crypto.sign("sha256", Buffer.from(data), PRIVATE_KEY);
  return `${data}.${b64url(sig)}`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const json = (code, body) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === "/.well-known/openid-configuration") {
    json(200, {
      issuer: ISSUER,
      jwks_uri: `${ISSUER}/.well-known/jwks.json`,
      token_endpoint: `${ISSUER}/token`,
      response_types_supported: ["id_token"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
    });
  } else if (url.pathname === "/.well-known/jwks.json") {
    json(200, JWKS);
  } else if (url.pathname === "/token") {
    json(200, {
      access_token: signJwt({ iss: ISSUER, sub: SUBJECT, aud: AUDIENCE }),
      token_type: "Bearer",
      expires_in: 3600,
    });
  } else {
    json(404, { error: "not_found" });
  }
});

// Loopback only: the public path is the TLS origin in infra/nginx/agent-vm2.conf.
// Nothing that reaches this port is trusted — it mints a token and nothing else.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`OIDC issuer on 127.0.0.1:${PORT} issuer=${ISSUER} sub=${SUBJECT}`);
});