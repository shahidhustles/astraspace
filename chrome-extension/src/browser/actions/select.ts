import type { GroundedTarget, TargetResolutionResult } from "../types";
import type {
  GetSelectOptionsResult,
  SelectOption,
  SelectOptionIdentity,
  SelectOptionResult,
} from "./types";
import { SELECT_OPTIONS_LIMIT } from "./types";

export interface SelectDeps {
  resolveTarget: (target: GroundedTarget) => Promise<TargetResolutionResult>;
  invalidate: () => void;
  currentUrl: () => string;
}

export type SelectLookup =
  | { kind: "not_native" }
  | { kind: "missing" }
  | { kind: "ambiguous"; count: number }
  | { kind: "disabled_select" }
  | { kind: "disabled" }
  | { kind: "ok"; index: number; selected: boolean };

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
    const page = await element.evaluate(readSelectOptions, SELECT_OPTIONS_LIMIT);
    if (page === null) {
      return { ok: false, error: { code: "not_native_select", message: "Element is not a native select" } };
    }
    return {
      ok: true,
      url: deps.currentUrl(),
      options: page.records.slice(0, SELECT_OPTIONS_LIMIT),
      optionsTruncated: page.total > page.records.length,
    };
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
      case "disabled_select":
        return { ok: false, error: { code: "disabled_target", message: "Select is disabled" } };
      case "ok":
        if (lookup.selected) {
          return {
            ok: false,
            error: { code: "action_failed", message: "The requested option is already selected" },
          };
        }
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

export interface SelectOptionsPage {
  records: SelectOption[];
  total: number;
}

export function readSelectOptions(el: Element, limit: number = SELECT_OPTIONS_LIMIT): SelectOptionsPage | null {
  const view = el.ownerDocument.defaultView;
  if (!view || !(el instanceof view.HTMLSelectElement)) {
    return null;
  }
  const optionIsDisabled = (option: HTMLOptionElement): boolean =>
    el.disabled ||
    option.disabled ||
    (option.parentElement instanceof view.HTMLOptGroupElement && option.parentElement.disabled);
  const records: SelectOption[] = Array.from(el.options).map((option, index) => ({
    index,
    label: (option.textContent ?? "").replace(/\s+/g, " ").trim(),
    value: option.value,
    disabled: optionIsDisabled(option),
    selected: option.selected,
  }));
  return { records: records.slice(0, limit), total: records.length };
}

export function findOptionMatch(el: Element, identity: SelectOptionIdentity): SelectLookup {
  const view = el.ownerDocument.defaultView;
  if (!view || !(el instanceof view.HTMLSelectElement)) {
    return { kind: "not_native" };
  }
  if (el.disabled) {
    return { kind: "disabled_select" };
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
  if (
    option.disabled ||
    (option.parentElement instanceof view.HTMLOptGroupElement && option.parentElement.disabled)
  ) {
    return { kind: "disabled" };
  }
  return { kind: "ok", index: identity.index, selected: option.selected };
}

export function applyOptionSelection(el: Element, index: number): number | null {
  const view = el.ownerDocument.defaultView;
  if (!view || !(el instanceof view.HTMLSelectElement) || el.disabled) {
    return null;
  }
  const option = el.options[index];
  if (
    !option ||
    option.disabled ||
    (option.parentElement instanceof view.HTMLOptGroupElement && option.parentElement.disabled)
  ) {
    return null;
  }
  const changed = el.selectedIndex !== index;
  el.selectedIndex = index;
  if (changed) {
    el.dispatchEvent(new view.Event("input", { bubbles: true }));
    el.dispatchEvent(new view.Event("change", { bubbles: true }));
  }
  return el.selectedIndex;
}
