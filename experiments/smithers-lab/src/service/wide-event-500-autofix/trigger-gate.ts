import type { TriggerGateDecision, WideEvent500AutofixTrigger } from "../../util/types";

export function evaluateWideEvent500Trigger(
  input: WideEvent500AutofixTrigger,
): TriggerGateDecision {
  if (!input.isRootRequest) {
    return {
      accepted: false,
      reason: "Only root requests are eligible for autofix diagnosis",
    };
  }

  if (input.statusCode < 500) {
    return {
      accepted: false,
      reason: "Only >=500 responses are eligible for autofix diagnosis",
    };
  }

  if (input.occurrenceCount >= 3) {
    return {
      accepted: true,
      reason: "Recurring fingerprint met automatic diagnosis threshold",
    };
  }

  if (input.severity === "critical") {
    return {
      accepted: true,
      reason: "Critical severity met immediate diagnosis threshold",
    };
  }

  return {
    accepted: false,
    reason: "Fingerprint has not met the recurrence or severity threshold",
  };
}
