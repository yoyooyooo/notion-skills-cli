"""Recognize behavioral assertion failures from the retained test-runner result."""
import json
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


def immutable_runtime_scope_failures(result):
    """Both surviving SDK readers must fail on their creator's closed runtime."""
    if not failed_assertion(result):
        return None
    assertions = getattr(result, "real_assertions", [])
    title = ("two public SDK runtimes share only exact immutable bytes, and creator "
             "cancellation preserves the survivor (eligibility delay {} ms)")
    expected = {title.format(delay) for delay in [0, 1200]}
    if len(assertions) != 2 or {a["fullName"] for a in assertions} != expected:
        return None
    failures = []
    for assertion in assertions:
        messages = assertion.get("failureMessages", [])
        if assertion["status"] != "failed" or len(messages) != 1:
            return None
        message = ANSI.sub("", messages[0])
        prefix = "AssertionError: "
        if not message.startswith(prefix):
            return None
        try:
            payload, end = json.JSONDecoder().raw_decode(message[len(prefix):])
        except json.JSONDecodeError:
            return None
        suffix = message[len(prefix) + end:]
        if (not suffix.startswith(": expected 'failed' to be 'ready'") or
                not re.search(r"\n\s+at ready \([^\n]*sdk-immutable-read\.node\.test\.ts:\d+:\d+\)", suffix)):
            return None
        if not isinstance(payload, dict) or payload.get("status") != "failed":
            return None
        error = payload.get("error", {})
        if not isinstance(error, dict):
            return None
        if error.get("code") == "NOTION_SCHEDULER_UNAVAILABLE":
            owner = "creator_scheduler"
        elif error.get("code") == "STATE_CONFIG_ERROR" and isinstance(error.get("details"), dict) and all(
                error["details"].get(key) == value for key, value in {
                    "phase": "sqlite_state", "error_tag": "SqlError",
                    "operation": "execute", "native_code": "ERR_INVALID_STATE",
                }.items()):
            owner = "creator_sqlite"
        else:
            return None
        failures.append({"test": assertion["fullName"], "closed_owner": owner})
    return failures
