## §24. Security and Privacy

Atlas is local-first: the repository on the user’s machine is the only canonical store (§25.1), private by default — never published or pushed to a remote without an explicit user decision.

Standing rules — MVP and beyond; relaxing any line requires a Decision Log entry (§25.5’s external connectors arrive only that way):

```text
send nothing anywhere on Atlas’s own initiative
  (no telemetry, background sync, auto-push)
read no secrets, never scan .env
store no credentials
modify no production resources
```

User-initiated agent sessions are the one legal outward transit: invoking an agent on Atlas data is the user’s explicit act, and the user chooses the model provider. Secrets never ride along — the ignore paths below stay out of any agent context.

Ignore paths:

```text
.env
.env.*
secrets/
node_modules/
.venv/
dist/
build/
.git/
```

---

