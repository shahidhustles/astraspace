import type {
  ActionCompletionStatus,
  ActionSettleSignals,
  ScrollStabilitySignal,
} from "./types";
import type { ClickMeasurement } from "../actions/types";

// Clicks prove settlement through their strongest recorded hop, an exact
// element expectation, or DOM plus layout stability. Anything weaker is an
// unproven settle, which reports timed_out even though the dispatch ran.
// Results carrying no settle evidence at all keep the pre-barrier behavior.
export function clickCompletionStatus(measurement: ClickMeasurement): ActionCompletionStatus {
  if (!measurement.expectation && !measurement.layout && !measurement.signals) {
    return "completed";
  }
  if (measurement.expectation) {
    const status = measurement.expectation.status;
    if (status === "satisfied") {
      return measurement.signals ? signalsConfirm(measurement.signals) : "timed_out";
    }
    return status === "cancelled" ? "cancelled" : "timed_out";
  }
  if (measurement.outcome === "navigation" || measurement.outcome === "same_document") {
    return "completed";
  }
  if (measurement.layout?.status === "stable") {
    return signalsConfirm(measurement.signals);
  }
  return "timed_out";
}

// Type, clear, keypress, and select_option settle on tracked quiet readings.
export function signalsCompletionStatus(signals?: ActionSettleSignals): ActionCompletionStatus {
  if (!signals) {
    return "completed";
  }
  if (signals.network.status === "cancelled" || signals.dom.status === "cancelled") {
    return "cancelled";
  }
  return signalsConfirm(signals);
}

export function scrollCompletionStatus(stability?: ScrollStabilitySignal): ActionCompletionStatus {
  if (!stability || stability.status === "stable") {
    return "completed";
  }
  return stability.status === "cancelled" ? "cancelled" : "timed_out";
}

function signalsConfirm(signals?: ActionSettleSignals): ActionCompletionStatus {
  if (!signals) {
    return "completed";
  }
  if (signals.network.status === "cancelled" || signals.dom.status === "cancelled") {
    return "cancelled";
  }
  const unsettled =
    signals.network.status === "activity_timeout" || signals.dom.status === "activity_timeout";
  return unsettled ? "timed_out" : "completed";
}
