"use client";

import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react";

import { useConsole } from "@/components/console-context";

/*
 * Form fields. Each keeps what is being typed in its own state and reports a clean value
 * upward, so trimming or rejecting a half-typed number never fights the cursor. A form
 * whose values are replaced from outside (Discard, a save) remounts its fields by key.
 */

interface FrameProps {
  label: string;
  hint?: string;
  /** Span both columns of the form grid. */
  wide?: boolean;
}

function Frame({
  id,
  label,
  hint,
  wide,
  tag,
  children,
}: FrameProps & { id: string; tag?: ReactNode; children: ReactNode }) {
  return (
    <div className={`field${wide ? " wide" : ""}`}>
      <label htmlFor={id}>
        {label}
        {tag}
      </label>
      {children}
      {hint ? <p className="hint">{hint}</p> : null}
    </div>
  );
}

interface TextFieldProps extends FrameProps {
  value: string | null | undefined;
  onChange: (value: string) => void;
  /** A field the candidate must fill in: empty is stored as the placeholder and tagged "needed". */
  required?: boolean;
  multiline?: boolean;
  rows?: number;
  type?: "text" | "email" | "url";
  placeholder?: string;
}

export function TextField({
  value,
  onChange,
  required = false,
  multiline = false,
  rows = 3,
  type = "text",
  placeholder,
  ...frame
}: TextFieldProps) {
  const id = useId();
  const unfilledMarker = useConsole().boot?.placeholder ?? "CHANGE_ME";
  // A required field that still holds the marker is shown empty, never as "CHANGE_ME".
  const [text, setText] = useState(() => (required && (value ?? "").includes(unfilledMarker) ? "" : (value ?? "")));
  const empty = !text.trim();

  const edit = (raw: string) => {
    setText(raw);
    const clean = multiline ? raw : raw.trim();
    onChange(required && !raw.trim() ? unfilledMarker : clean);
  };

  const shared = { id, value: text, placeholder, autoComplete: "off" };
  return (
    <Frame id={id} {...frame} tag={required && empty ? <span className="needed">needed</span> : null}>
      {multiline ? (
        <textarea {...shared} rows={rows} onChange={(event) => edit(event.target.value)} />
      ) : (
        <input {...shared} type={type} onChange={(event) => edit(event.target.value)} />
      )}
    </Frame>
  );
}

interface NumberFieldBase extends FrameProps {
  min?: number;
  max?: number;
  step?: number;
  /** Whole numbers only. */
  integer?: boolean;
  /** Shown after the input, e.g. "USD / hour". */
  unit?: string;
}

type NumberFieldProps = NumberFieldBase &
  (
    | { nullable: true; value: number | null; onChange: (value: number | null) => void }
    | { nullable?: false; value: number; onChange: (value: number) => void }
  );

export function NumberField(props: NumberFieldProps) {
  const { min, max, step, integer = false, unit, label, hint, wide } = props;
  const id = useId();
  const [text, setText] = useState(props.value === null ? "" : String(props.value));
  const [invalid, setInvalid] = useState(false);

  const edit = (raw: string) => {
    setText(raw);
    const blank = raw.trim() === "";
    const parsed = Number(raw);
    const valid = blank ? props.nullable === true : Number.isFinite(parsed) && (!integer || Number.isInteger(parsed));
    setInvalid(!valid);
    // An unusable entry is flagged and kept out of the draft; the last good value stands.
    if (!valid) return;
    if (props.nullable) props.onChange(blank ? null : parsed);
    else props.onChange(parsed);
  };

  const input = (
    <input
      id={id}
      type="number"
      inputMode={integer ? "numeric" : "decimal"}
      step={step ?? "any"}
      min={min}
      max={max}
      value={text}
      aria-invalid={invalid}
      onChange={(event) => edit(event.target.value)}
    />
  );
  return (
    <Frame id={id} label={label} hint={hint} wide={wide}>
      {unit ? (
        <div className="with-unit">
          {input}
          <span>{unit}</span>
        </div>
      ) : (
        input
      )}
    </Frame>
  );
}

interface SelectFieldProps extends FrameProps {
  value: string;
  options: ReadonlyArray<readonly [value: string, label: string]>;
  onChange: (value: string) => void;
}

export function SelectField({ value, options, onChange, ...frame }: SelectFieldProps) {
  const id = useId();
  return (
    <Frame id={id} {...frame}>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map(([option, label]) => (
          <option key={option} value={option}>
            {label}
          </option>
        ))}
      </select>
    </Frame>
  );
}

export function CheckField({
  label,
  hint,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  /** A sentence or two under the label saying what on and off mean. */
  hint?: string;
  checked: boolean;
  /** Shown but not changeable, for a setting that has no effect as things stand. */
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={`check${disabled ? " disabled" : ""}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span>
        {label}
        {hint ? <small>{hint}</small> : null}
      </span>
    </label>
  );
}

/** One choice among a few, each with room to say what it means. */
export function RadioField<T extends string>({
  legend,
  options,
  value,
  onChange,
}: {
  legend: string;
  options: ReadonlyArray<{ value: T; label: string; hint?: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  const name = useId();
  return (
    <fieldset className="choices">
      <legend>{legend}</legend>
      {options.map((option) => (
        <label className="check" key={option.value}>
          <input type="radio" name={name} checked={value === option.value} onChange={() => onChange(option.value)} />
          <span>
            {option.label}
            {option.hint ? <small>{option.hint}</small> : null}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

interface TagsFieldProps extends FrameProps {
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
}

/** A list of short names: type one and press Enter or comma; Backspace removes the last. */
export function TagsField({ value, onChange, placeholder = "Type and press Enter", ...frame }: TagsFieldProps) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");

  const commit = () => {
    const parts = text.split(",").map((part) => part.trim()).filter(Boolean);
    if (!parts.length) return;
    const next = [...value];
    for (const part of parts) {
      if (!next.some((have) => have.toLowerCase() === part.toLowerCase())) next.push(part);
    }
    setText("");
    onChange(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commit();
    } else if (event.key === "Backspace" && !text && value.length) {
      onChange(value.slice(0, -1));
    }
  };

  return (
    <Frame id={id} {...frame}>
      <div className="tags">
        {value.map((tag, index) => (
          <span className="chip" key={`${index}:${tag}`}>
            {tag}
            <button
              type="button"
              aria-label={`Remove ${tag}`}
              onClick={() => {
                onChange(value.filter((_, at) => at !== index));
                input.current?.focus();
              }}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={input}
          id={id}
          type="text"
          value={text}
          placeholder={placeholder}
          autoComplete="off"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={commit}
        />
      </div>
    </Frame>
  );
}
