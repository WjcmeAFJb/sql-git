import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const alertVariants = cva(
  "relative w-full rounded-lg border px-3 py-2 text-sm [&>svg]:mr-2 [&>svg]:inline-block [&>svg]:h-4 [&>svg]:w-4 [&>svg]:align-[-2px]",
  {
    variants: {
      variant: {
        default: "bg-background text-foreground",
        info: "border-sky-500/30 bg-sky-500/10 text-sky-300",
        success:
          "border-[hsl(var(--success))]/30 bg-[hsl(var(--success))]/10 text-[hsl(var(--success))]",
        warning:
          "border-[hsl(var(--warning))]/30 bg-[hsl(var(--warning))]/10 text-[hsl(var(--warning))]",
        destructive:
          "border-destructive/40 bg-destructive/10 text-destructive",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface AlertProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof alertVariants> {}

export const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  ({ className, variant, ...props }, ref) => (
    <div ref={ref} className={cn(alertVariants({ variant }), className)} {...props} />
  ),
);
Alert.displayName = "Alert";
