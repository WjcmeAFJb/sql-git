import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronLeft, ChevronRight, Check } from "lucide-react";

export type FieldText = {
  type: "text";
  key: string;
  label: string;
  initial?: string;
  placeholder?: string;
  optional?: boolean;
};
export type FieldNumber = {
  type: "number";
  key: string;
  label: string;
  initial?: string;
  min?: number;
  placeholder?: string;
};
export type FieldSelect = {
  type: "select";
  key: string;
  label: string;
  options: Array<{ label: string; value: string }>;
};
export type FormField = FieldText | FieldNumber | FieldSelect;

export type FormSpec = {
  title: string;
  description?: string;
  fields: FormField[];
  onSubmit: (values: Record<string, string>) => Promise<string | null> | string | null;
};

/**
 * Multi-step form rendered in a shadcn Dialog. Users see one field at a
 * time (to mirror the TUI's wizard flow), but can navigate back and forth.
 * `onSubmit` returns either `null` (success — dialog closes) or an error
 * string (displayed beneath the last field; user can correct and retry).
 */
export function Wizard({
  spec,
  open,
  onClose,
}: {
  spec: FormSpec | null;
  open: boolean;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [current, setCurrent] = useState(0);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Reset state when the spec changes (each form open is a fresh instance).
  useEffect(() => {
    if (!spec) return;
    const initial: Record<string, string> = {};
    for (const f of spec.fields) {
      if (f.type === "text" || f.type === "number") initial[f.key] = f.initial ?? "";
      else initial[f.key] = f.options[0]?.value ?? "";
    }
    setValues(initial);
    setCurrent(0);
    setFieldError(null);
    setSubmitError(null);
    setSubmitting(false);
  }, [spec]);

  if (!spec) return null;
  const field = spec.fields[current];
  const isLast = current === spec.fields.length - 1;

  const validateCurrent = (): boolean => {
    const v = values[field.key] ?? "";
    if (field.type === "number") {
      const n = Number(v);
      if (!Number.isFinite(n)) {
        setFieldError("must be a number");
        return false;
      }
      if ("min" in field && field.min !== undefined && n < field.min) {
        setFieldError(`must be ≥ ${field.min}`);
        return false;
      }
    }
    if (field.type === "text" && !("optional" in field && field.optional) && !v) {
      setFieldError("required");
      return false;
    }
    setFieldError(null);
    return true;
  };

  const advance = () => {
    if (!validateCurrent()) return;
    setCurrent((c) => c + 1);
  };

  const submit = async () => {
    if (!validateCurrent()) return;
    setSubmitting(true);
    try {
      const res = await spec.onSubmit(values);
      if (res === null) {
        onClose();
      } else {
        setSubmitError(res);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && field.type !== "select") {
      e.preventDefault();
      if (isLast) void submit();
      else advance();
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onClose() : null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{spec.title}</DialogTitle>
          {spec.description ? (
            <DialogDescription>{spec.description}</DialogDescription>
          ) : null}
        </DialogHeader>

        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          step {current + 1} of {spec.fields.length}
          <div className="ml-auto flex gap-1">
            {spec.fields.map((_, i) => (
              <span
                key={i}
                className={
                  "h-1.5 w-6 rounded-full " +
                  (i < current
                    ? "bg-primary"
                    : i === current
                      ? "bg-primary/70"
                      : "bg-muted")
                }
              />
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="wizard-field">{field.label}</Label>
          {field.type === "text" || field.type === "number" ? (
            <Input
              id="wizard-field"
              autoFocus
              type={field.type === "number" ? "text" : "text"}
              inputMode={field.type === "number" ? "decimal" : undefined}
              placeholder={field.placeholder}
              value={values[field.key] ?? ""}
              onChange={(e) =>
                setValues((v) => ({ ...v, [field.key]: e.target.value }))
              }
              onKeyDown={onKey}
            />
          ) : (
            <Select
              value={values[field.key] ?? ""}
              onValueChange={(val) =>
                setValues((v) => ({ ...v, [field.key]: val }))
              }
            >
              <SelectTrigger id="wizard-field">
                <SelectValue placeholder="Select…" />
              </SelectTrigger>
              <SelectContent>
                {field.options.map((o) => (
                  <SelectItem key={o.value} value={o.value || "__empty__"}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {fieldError ? (
            <p className="text-xs text-destructive">{fieldError}</p>
          ) : null}
        </div>

        {submitError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            {submitError}
          </div>
        ) : null}

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setCurrent((c) => Math.max(0, c - 1))}
            disabled={current === 0 || submitting}
          >
            <ChevronLeft className="h-3 w-3" /> Back
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          {isLast ? (
            <Button onClick={() => void submit()} disabled={submitting}>
              <Check className="h-3 w-3" /> {submitting ? "Submitting…" : "Submit"}
            </Button>
          ) : (
            <Button onClick={advance}>
              Next <ChevronRight className="h-3 w-3" />
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** shadcn Select can't carry empty-string values; we sentinel them and unwrap. */
export function unsentinelSelectValue(v: string | undefined): string {
  if (v === undefined) return "";
  return v === "__empty__" ? "" : v;
}
