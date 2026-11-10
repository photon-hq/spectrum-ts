import json
import os
import re
import subprocess
import tempfile
import uuid

STABLE = re.compile(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z")
DIFF_LIMIT = 100_000
TRUNCATED = "\n\n... [diff truncated at 100000 characters]"


def git(*args):
    return subprocess.check_output(["git", *args], text=True).strip()


def stable_version(tag):
    match = STABLE.fullmatch(tag)
    if not match:
        raise ValueError("Documentation requires a stable vX.Y.Z tag")
    return tuple(map(int, match.groups()))


def previous_stable_tag(tags, tag):
    version = stable_version(tag)
    lower = [candidate for candidate in tags if STABLE.fullmatch(candidate)
             and stable_version(candidate) < version]
    return max(lower, key=stable_version) if lower else None


def release_diff(tag, previous):
    base = f"refs/tags/{previous}" if previous else git("hash-object", "-t", "tree", "/dev/null")
    with tempfile.TemporaryFile(mode="w+", encoding="utf-8", errors="replace") as output:
        subprocess.run(["git", "diff", base, f"refs/tags/{tag}"], stdout=output, check=True)
        output.seek(0)
        diff = output.read(DIFF_LIMIT + 1)
    return diff[:DIFF_LIMIT].replace("\0", "") + (TRUNCATED if len(diff) > DIFF_LIMIT else "")


def codeowners(tag):
    for path in (".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"):
        if git("ls-tree", "--name-only", f"refs/tags/{tag}", "--", path):
            owners = set()
            for line in git("show", f"refs/tags/{tag}:{path}").splitlines():
                for owner in line.split("#", 1)[0].split()[1:]:
                    if owner.startswith("@"):
                        owners.add(owner[1:])
            return ",".join(sorted(owners))
    return ""


def main():
    tag = os.environ["RELEASE_TAG"]
    version = stable_version(tag)
    release = json.loads(subprocess.check_output([
        "gh", "api", f"repos/{os.environ['GITHUB_REPOSITORY']}/releases/tags/{tag}"
    ], text=True))
    if release["tag_name"] != tag or release["prerelease"] or release["draft"]:
        raise ValueError("Documentation requires a published stable release")
    previous = os.environ.get("PREVIOUS_TAG") or previous_stable_tag(git("tag", "--list", "v*").splitlines(), tag)
    if previous and stable_version(previous) >= version:
        raise ValueError("The docs baseline must be a lower stable release")
    context = {
        "version": tag[1:],
        "release-tag": tag,
        "release-notes": os.environ.get("RELEASE_NOTES") or release["body"] or "",
        "changes-diff": release_diff(tag, previous),
        "reviewers": codeowners(tag),
    }
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        for key, value in context.items():
            delimiter = f"DOCS_{uuid.uuid4().hex}"
            output.write(f"{key}<<{delimiter}\n{value}\n{delimiter}\n")


if __name__ == "__main__":
    main()
