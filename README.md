# Atlas

Atlas is a knowledge-state graph at the SDD stage, with a Phase 1 graph-builder spike.

## Design specification

[`SDD.md`](SDD.md) is the map and stable-numbered § index; each section lives in its own file under [`spec/`](spec/). Start with the index, then open only the section files needed for the question at hand.

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
