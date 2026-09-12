import argparse
from email.parser import BytesParser
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import tomllib
import venv
import zipfile


ROOT = Path(__file__).resolve().parents[1]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def run(args, **kwargs):
    return subprocess.check_output([str(arg) for arg in args], text=True, encoding="utf-8", **kwargs).strip()


def metadata():
    cargo = tomllib.loads((ROOT / "Cargo.toml").read_text())["package"]
    project = tomllib.loads((ROOT / "pyproject.toml").read_text())["project"]
    lock = tomllib.loads((ROOT / "Cargo.lock").read_text())["package"]
    version = cargo["version"]
    require(re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version), "use a stable X.Y.Z version")
    require(project["dynamic"] == ["version"], "Python version must come from Cargo.toml")
    require(next(p["version"] for p in lock if p["name"] == cargo["name"] and "source" not in p) == version, "Cargo.lock version differs")
    return project["name"], version


def check_metadata(raw, name, version):
    info = BytesParser().parsebytes(raw)
    require(info["Name"] == name and info["Version"] == version, "distribution name or version differs")
    require(info["License-Expression"] == "MIT", "MIT license metadata missing")
    require(info.get_all("License-File") == ["LICENSE"], "license file metadata differs")
    require(not info.get_all("Requires-Dist"), "binary wheel must have no Python runtime dependencies")


def artifacts(directory, name, version):
    stem = re.sub(r"[-_.]+", "_", name) + "-" + version
    found = sorted(directory.iterdir())
    require(found, "no distribution artifacts")
    for path in found:
        if path.suffix == ".whl":
            require(path.name.startswith(stem + "-py3-none-"), "wheel name/version/bindings differ")
            executable = "tatlas.exe" if "-win_" in path.name else "tatlas"
            info = stem + ".dist-info/"
            with zipfile.ZipFile(path) as archive:
                expected = {stem + ".data/scripts/" + executable, info + "METADATA", info + "WHEEL", info + "RECORD", info + "licenses/LICENSE"}
                require(set(archive.namelist()) == expected and len(archive.namelist()) == len(expected), "unexpected wheel payload")
                check_metadata(archive.read(info + "METADATA"), name, version)
                require(archive.read(info + "licenses/LICENSE") == (ROOT / "LICENSE").read_bytes(), "wheel license differs")
                wheel = BytesParser().parsebytes(archive.read(info + "WHEEL"))
                tag = path.name.removeprefix(stem + "-").removesuffix(".whl")
                require(wheel.get_all("Tag") == [tag] and wheel["Root-Is-Purelib"] == "false", "wheel tags differ")
        elif path.name == stem + ".tar.gz":
            expected = {"Cargo.toml", "Cargo.lock", "pyproject.toml", "README.md", "LICENSE", "PKG-INFO"}
            expected.update(p.relative_to(ROOT).as_posix() for p in (ROOT / "src").rglob("*.rs"))
            with tarfile.open(path) as archive:
                files = [p for p in archive.getmembers() if p.isfile()]
                require(all(p.isfile() or p.isdir() for p in archive.getmembers()), "sdist contains a link or special file")
                require({p.name for p in files} == {stem + "/" + p for p in expected} and len(files) == len(expected), "unexpected source payload")
                check_metadata(archive.extractfile(stem + "/PKG-INFO").read(), name, version)
                for member in files:
                    relative = PurePosixPath(member.name).relative_to(stem).as_posix()
                    if relative != "PKG-INFO":
                        require(archive.extractfile(member).read() == (ROOT / relative).read_bytes(), "source file differs: " + relative)
        else:
            raise ValueError("unexpected artifact: " + path.name)
        print("Checked " + path.name)


def probe(executable, version):
    environment = dict(os.environ, PATH="")
    require(run([executable, "--version"], env=environment) == "tatlas " + version, "installed CLI version differs")
    with tempfile.TemporaryDirectory(prefix="vera-example-atlas-") as directory:
        data = Path(directory) / "Vera Example \u0410\u0442\u043b\u0430\u0441"
        def cli(*args):
            return json.loads(run([executable, "--data-dir", data, "--json", *args], env=environment))
        material = "https://example.org/vera-example?part=1&exact=2"
        original = "Vera Example: \u043e\u0442\u043a\u0440\u044b\u043b\u0430 \u0432\u0432\u0435\u0434\u0435\u043d\u0438\u0435."
        created = cli("add", "--id", "vera-example-1", "--material", material, "--actor", "Vera Example", "--original", original, "--context", "Vera Example research")["record"]
        require(created["revision"] == 1 and created["interaction"]["details"]["original"] == original, "installed add failed")
        cli("mark", "--material", material, "--state", "focus", "--if-revision", "0")
        require(cli("list", "--context", "research", "--state", "focus")["records"] == [created], "installed list failed")
        edited = cli("edit", "--id", "vera-example-1", "--if-revision", "1", "--note", "Vera Example correction")["record"]
        require(edited["revision"] == 2 and edited["interaction"]["details"]["original"] == original, "installed edit failed")
        require(cli("get", "--id", "vera-example-1")["record"] == edited, "installed get failed")
        cli("rm", "--id", "vera-example-1", "--if-revision", "2")
        require(cli("get", "--id", "vera-example-1")["record"]["status"] == "deleted", "installed delete failed")
        cli("mark", "--material", material, "--state", "none", "--if-revision", "1")
        require(cli("marks")["marks"][material] == {"state": "none", "revision": 2}, "installed clear mark failed")
        require(cli("list")["records"] == [], "deleted record remains listed")
    print("Installed CLI passed with an empty PATH: " + str(executable))


def install(path, version, source=False):
    path = path.resolve()
    with tempfile.TemporaryDirectory(prefix="vera-example-install-") as directory:
        root = Path(directory)
        environment = dict(os.environ, PIP_DISABLE_PIP_VERSION_CHECK="1", CARGO_TARGET_DIR=str(root / "target"))
        virtual = root / "pip"
        venv.EnvBuilder(with_pip=True).create(virtual)
        binaries = virtual / ("Scripts" if os.name == "nt" else "bin")
        python = binaries / ("python.exe" if os.name == "nt" else "python")
        executable = "tatlas.exe" if os.name == "nt" else "tatlas"
        print(run([python, "-m", "pip", "install", "--no-deps", path], env=environment))
        probe(binaries / executable, version)
        if not source:
            uv = shutil.which("uv")
            require(uv, "uv is required for the wheel install probe")
            environment.update(UV_TOOL_DIR=str(root / "uv-tools"), UV_TOOL_BIN_DIR=str(root / "uv-bin"), UV_CACHE_DIR=str(root / "uv-cache"), UV_PYTHON_DOWNLOADS="never")
            print(run([uv, "tool", "install", "--python", sys.executable, "--no-index", path], env=environment))
            probe(root / "uv-bin" / executable, version)
            require(run([uv, "tool", "run", "--isolated", "--python", sys.executable, "--no-index", "--from", path, "tatlas", "--version"], env=environment) == "tatlas " + version, "uvx version differs")


def main():
    parser = argparse.ArgumentParser(description="Check Trail Atlas release artifacts and actual pip/uv installs")
    parser.add_argument("mode", choices=["version", "release", "artifacts", "wheel", "source"])
    parser.add_argument("value", nargs="?")
    args = parser.parse_args()
    name, version = metadata()
    if args.mode == "version":
        print(name + " " + version)
    elif args.mode == "release":
        require(args.value == "v" + version, "tag must equal v plus the Cargo version")
        subprocess.run(["git", "merge-base", "--is-ancestor", "HEAD", "origin/main"], cwd=ROOT, check=True)
    else:
        require(args.value, "a distribution path is required")
        path = Path(args.value)
        if args.mode == "artifacts":
            artifacts(path, name, version)
        else:
            install(path, version, source=args.mode == "source")


if __name__ == "__main__":
    main()
