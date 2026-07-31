# Atlas

Atlas is a specification-led knowledge-state graph under a **partial freeze**. The approved knowledge-domain vertical is active; Body Atlas remains design-only and implementation-frozen until the objective gates in [§29's Body Atlas freeze section](spec/29-implementation-phases.md) are satisfied and a new explicit owner decision is recorded. See [§29](spec/29-implementation-phases.md) for the current implementation posture.

## Design specification

[`SDD.md`](SDD.md) is the map and stable-numbered § index; each section lives in its own file under [`spec/`](spec/). Start with the index, then open only the section files needed for the question at hand.

## Viewing a graph

The viewer is static and fetches `graph/atlas-graph.json` relative to itself, so it needs an HTTP origin where `viewer/` and `graph/` are siblings — `file://` will not do. Two commands provide one:

- `python3 scripts/view_demo.py` builds the invented demo fixtures into a temporary directory and serves them at `http://127.0.0.1:8137/viewer/index.html`.
- `python3 scripts/serve_instance.py INSTANCE_DIR` serves a private instance's already-built graph together with this checkout's viewer at `http://127.0.0.1:8138/viewer/index.html` (`--port` overrides). The instance path is required — the engine never guesses or remembers where private data lives.

Port 8138 is the fixed origin an embedding shell allowlists in its CSP (§16.4); a random port could not be. The command is read-only: it binds loopback explicitly, answers GET and HEAD over a closed route table (the viewer's own files plus the one graph file — no listing, no other instance path), serves only requests addressed to `127.0.0.1`/`localhost` at its own port, and writes nothing. Building the graph belongs to `scripts/build_atlas_graph.py`.

## Ecosystem

Atlas is the knowledge layer of [selfos](https://github.com/jointsome0-lgtm/selfos), a personal state platform, alongside [ephemeris](https://github.com/jointsome0-lgtm/ephemeris) (activity) and [exp2res](https://github.com/jointsome0-lgtm/exp2res) (experience).

## Public data boundary

This is a public engine repository. All real data lives in a private instance repository outside this checkout. Only invented demo fixtures authored by the synthetic persona and marked with the literal `Vera Example` belong here. The [architecture](https://github.com/jointsome0-lgtm/selfos/blob/main/docs/architecture.md), [private-instance ownership](https://github.com/jointsome0-lgtm/selfos/blob/main/docs/instance.md), and [deletion](https://github.com/jointsome0-lgtm/selfos/blob/main/docs/deletion.md) contracts are canonical in selfos.

## Public hygiene

Run the public-hygiene checker with `python3 scripts/check_public_hygiene.py`. Enable the committed pre-commit hook once per clone with `git config core.hooksPath .githooks`.

## Security

Security policy is canonical in the [selfos umbrella repository](https://github.com/jointsome0-lgtm/selfos/blob/main/SECURITY.md).

## License

[MIT](LICENSE)
