import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

const buttonStyles = cva("button", {
  variants: {
    variant: { primary: "button-primary", outline: "button-outline", ghost: "button-ghost" },
    size: { md: "", sm: "button-sm", lg: "button-lg" },
  },
  defaultVariants: { variant: "primary", size: "md" },
});

export function Button({
  asChild,
  variant,
  size,
  className,
  ...props
}: ComponentProps<"button"> & VariantProps<typeof buttonStyles> & { asChild?: boolean }) {
  const Component = asChild ? Slot : "button";
  return <Component className={cn(buttonStyles({ variant, size }), className)} {...props} />;
}
