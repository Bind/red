import * as React from "react";
import type { ToastActionElement, ToastProps } from "@/components/ui/toast";

export type ToastRecord = Omit<Partial<ToastProps>, "title" | "description" | "action"> & {
  id: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: ToastActionElement;
};

export function useToast(): {
  toasts: ToastRecord[];
  toast: (toast: Omit<ToastRecord, "id">) => string;
  dismiss: (id?: string) => void;
} {
  return {
    toasts: [],
    toast(toast) {
      return toast.title ? String(toast.title) : "toast";
    },
    dismiss() {},
  };
}
