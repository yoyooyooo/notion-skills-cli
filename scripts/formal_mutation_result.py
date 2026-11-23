"""Recognize behavioral assertion failures from the retained test-runner result."""
import re


ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
DIAGNOSTIC = re.compile(
    r"(?m)^(?:\s*|::error[^\n]*?title=)"
    r"((?:error:|(?:[A-Za-z]*Error)(?:\s*\[[^\]\n]+\])?:)[^\n]*)"
)
ASSERTION = re.compile(
    r"^(?:error:\s*)?(?:AssertionError(?:\s*\[[^\]]+\])?:|expect\([^\n]*\)\."
    r"(?:(?:rejects|resolves)\.)?(?:not\.)?\w+\()"
)
TIMEOUT = re.compile(r"(?im)^\s*(?:\^ this test timed out\b|HARNESS TIMEOUT\b)")


def failed_assertion(result):
    """A test failure needs an actual assertion diagnostic, without runner errors."""
    if result.returncode <= 0:
        return False
    failures = getattr(result, "assertion_failures", None)
    output = ANSI.sub("", result.stdout + result.stderr)
    if failures is not None:
        failures = [ANSI.sub("", message) for message in failures]
        output += "\n" + "\n".join(failures)
    diagnostics = DIAGNOSTIC.findall(output)
    if TIMEOUT.search(output) or any(not ASSERTION.match(message) for message in diagnostics):
        return False
    if failures is not None:
        return bool(failures) and all(ASSERTION.match(message) for message in failures)
    return bool(re.search(r"(?m)^\(fail\)\s+\S", output) and diagnostics)
