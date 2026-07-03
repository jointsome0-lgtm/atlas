## §24. Security and Privacy

Atlas is local-first.

MVP should not:

```text
send files to remote services automatically
read secrets
scan .env
push to remote
modify production resources
store credentials
```

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

