import type { GroundedTarget, TargetResolutionResult } from "../types";
import type {
  GetSelectOptionsResult,
  SelectOption,
  SelectOptionIdentity,
  SelectOptionResult,
} from "./types";

export interface SelectDeps {
  resolveTarget: (target: GroundedTarget) => Promise<TargetResolutionResult>;
  invalidate: () => void;
  currentUrl: () => string;
}

export type SelectLookup =
  | { kind: "not_native" }
  | { kind: "missing" }
  | { kind: "ambiguous"; count: number }
  | { kind: "disabled" }
  | { kind: "ok"; index: number };

export async function getSelectOptions(
  target: GroundedTarget,
  deps: SelectDeps,
): Promise<GetSelectOptionsResult> {
  const resolved = await deps.resolveTarget(target);
  if (!resolved.ok) {
    return { ok: false, error: { code: resolved.code, message: resolved.reason, target: resolved.target } };
  }
  const element = resolved.element;
  try {
    const options = await element.evaluate(readSelectOptions);
    if (options === null) {
      return { ok: false, error: { code: "not_native_select", message: "Element is not a native select" } };
    }
    return { ok: true, url: deps.currentUrl(), options };
  } catch {
    return { ok: false, error: { code: "action_failed", message: "Element interaction failed" } };
  } finally {
    await element.dispose().catch(() => {});
  }
}

export async function selectOption(
  target: GroundedTarget,
  identity: SelectOptionIdentity,
  deps: SelectDeps,
): Promise<SelectOptionResult> {
  const resolved = await deps.resolveTarget(target);
  if (!resolved.ok) {
    return { ok: false, error: { code: resolved.code, message: resolved.reason, target: resolved.target } };
  }
  const element = resolved.element;
  try {
    const lookup = await element.evaluate(findOptionMatch, identity);
    switch (lookup.kind) {
      case "not_native":
        return { ok: false, error: { code: "not_native_select", message: "Element is not a native select" } };
      case "missing":
        return { ok: false, error: { code: "option_not_found", message: "No option matches the requested choice" } };
      case "ambiguous":
        return {
          ok: false,
          error: { code: "ambiguous_option", message: "Multiple options match the requested choice" },
        };
      case "disabled":
        return { ok: false, error: { code: "option_disabled", message: "The matching option is disabled" } };
      case "ok":
        break;
    }
    deps.invalidate();
    const selectedIndex = await element.evaluate(applyOptionSelection, lookup.index);
    if (selectedIndex !== lookup.index) {
      return { ok: false, error: { code: "action_failed", message: "The option could not be selected" } };
    }
    return { ok: true, url: deps.currentUrl(), selectedIndex };
  } catch {
    return { ok: false, error: { code: "action_failed", message: "Element interaction failed" } };
  } finally {
    await element.dispose().catch(() => {});
  }
}

export function readSelectOptions(el: Element): SelectOption[] | null {
  if (!(el instanceof HTMLSelectElement)) {
    return null;
  }
  return Array.from(el.options).map((option, index) => ({
    index,
    label: (option.textContent ?? "").replace(/\s+/g, " ").trim(),
    value: option.value,
    disabled: option.disabled,
    selected: option.selected,
  }));
}

export function findOptionMatch(el: Element, identity: SelectOptionIdentity): SelectLookup {
  if (!(el instanceof HTMLSelectElement)) {
    return { kind: "not_native" };
  }
  const label = identity.label.replace(/\s+/g, " ").trim();
  const labelOf = (option: HTMLOptionElement): string =>
    (option.textContent ?? "").replace(/\s+/g, " ").trim();
  const option = el.options[identity.index];
  if (!option || labelOf(option) !== label || option.value !== identity.value) {
    return { kind: "missing" };
  }
  const matches = Array.from(el.options).filter(
    (candidate) => labelOf(candidate) === label && candidate.value === identity.value,
  );
  if (matches.length > 1) {
    return { kind: "ambiguous", count: matches.length };
  }
  if (option.disabled) {
    return { kind: "disabled" };
  }
  return { kind: "ok", index: identity.index };
}

export function applyOptionSelection(el: Element, index: number): number | null {
  if (!(el instanceof HTMLSelectElement)) {
    return null;
  }
  const option = el.options[index];
  if (!option || option.disabled) {
    return null;
  }
  const changed = el.selectedIndex !== index;
  el.selectedIndex = index;
  if (changed) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  return el.selectedIndex;
}
