# Repository entry point

Google Cloud VM `alesa-personal-assistent/us-central1-a/alesa-vm` (instance ID `7077705867419574607`) is being retired. Do not add processes, cron, agent runs, sandbox or dependencies on it. Access is limited to inventory, export, reconciliation and shutdown. Use serverless and the own Agent Run API by default; use the existing VM in France only when a persistent process or local resource is required. Other Google services remain permitted. See [the exit issue](https://github.com/trained-assist/trained-agent-architecture/issues/145).

The GCP deploy workflows and old README architecture are migration history. Do not reactivate them. Coordinate shared endpoints, credentials, writers and the French VM with the integrator before changing them.
