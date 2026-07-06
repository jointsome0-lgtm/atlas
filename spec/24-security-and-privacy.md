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

`intake/` never enters default agent context: a delivered original keeps a foreign system's voice and may carry §32.6-class text (a raw health export) whether or not its records were marked — the one legitimate reader is the user-initiated flow processing a batch (§31.7, §33.2). Unlike the ignore paths this is a default, not an absolute: that flow is a session the user explicitly started for it (§32.6 discipline).

---

