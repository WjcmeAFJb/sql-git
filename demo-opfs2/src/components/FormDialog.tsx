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
import { Check } from "lucide-react";

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
  initial?: string;
};
export type FormField = FieldText | FieldNumber | FieldSelect;

export type FormSpec = {
  title: string;
  description?: string;
  fields: FormField[];
  submitLabel?: string;
  onSubmit: (values: Record<string, string>) => Promise<string | null> | string | null;
};

/**
 * Single-step form rendered in a shadcn Dialog. All fields are visible at
 * once; `onSubmit` returns either `null` (success — dialog closes) or an
 * error string shown at the bottom.
 */
export function FormDialog({
  spec,
  open,
  onClose,
}: {
  spec: FormSpec | null;
  open: boolean;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!spec) return;
    const initial: Record<string, string> = {};
    for (const f of spec.fields) {
      if (f.type === "text" || f.type === "number") {
        initial[f.key] = f.initial ?? "";
      } else {
        initial[f.key] = f.initial ?? f.options[0]?.value ?? "";
      }
    }
    setValues(initial);
    setErrors({});
    setSubmitError(null);
    setSubmitting(false);
  }, [spec]);

  if (!spec) return null;

  const validate = (): boolean => {
    const next: Record<string, string> = {};
    for (const f of spec.fields) {
      const v = values[f.key] ?? "";
      if (f.type === "number") {
        const n = Number(v);
        if (!Number.isFinite(n)) next[f.key] = "must be a number";
        else if ("min" in f && f.min !== undefined && n < f.min)
          next[f.key] = `must be ≥ ${f.min}`;
      } else if (f.type === "text" && !("optional" in f && f.optional) && !v) {
        next[f.key] = "required";
      }
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = async () => {
    if (!validate()) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await spec.onSubmit(values);
      if (res === null) onClose();
      else setSubmitError(res);
    } finally {
      setSubmitting(false);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
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

        <div className="space-y-3">
          {spec.fields.map((field, i) => (
            <div key={field.key} className="space-y-1.5">
              <Label htmlFor={`form-field-${field.key}`}>{field.label}</Label>
              {field.type === "text" || field.type === "number" ? (
                <Input
                  id={`form-field-${field.key}`}
                  autoFocus={i === 0}
                  type="text"
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
                  <SelectTrigger id={`form-field-${field.key}`}>
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
              {errors[field.key] ? (
                <p className="text-xs text-destructive">{errors[field.key]}</p>
              ) : null}
            </div>
          ))}
        </div>

        {submitError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            {submitError}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={submitting}>
            <Check className="h-3 w-3" />{" "}
            {submitting ? "Submitting…" : (spec.submitLabel ?? "Submit")}
          </Button>
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
