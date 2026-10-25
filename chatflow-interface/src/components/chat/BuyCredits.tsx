import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { jp, type CheckoutDTO, type PayCurrency } from "@/lib/api-client";
import { keys } from "@/lib/live";

// Buy a credit pack: Razorpay's pop-up for ₹ (INR), Stripe's hosted page
// for $ (USD). Credits land once the provider confirms the payment.

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void; on: (e: string, fn: (r: unknown) => void) => void };
  }
}

const RAZORPAY_JS = "https://checkout.razorpay.com/v1/checkout.js";

function loadRazorpay(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = RAZORPAY_JS;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Couldn't load Razorpay — check your connection"));
    document.head.appendChild(s);
  });
}

export const formatMoney = (amount: number, currency: PayCurrency) =>
  new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: amount % 100 ? 2 : 0,
  }).format(amount / 100);

export function BuyCreditsDialog({
  open,
  onOpenChange,
  defaultCurrency,
  email,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultCurrency: PayCurrency;
  email?: string | null;
}) {
  const qc = useQueryClient();
  const [currency, setCurrency] = useState<PayCurrency>(defaultCurrency);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => setCurrency(defaultCurrency), [defaultCurrency]);
  const packsQ = useQuery({ queryKey: ["credit-packs", currency], queryFn: () => jp.creditPacks(currency), enabled: open });

  const paid = () => {
    void qc.invalidateQueries({ queryKey: keys.me });
    onOpenChange(false);
  };

  const razorpay = async (c: Extract<CheckoutDTO, { provider: "razorpay" }>) => {
    await loadRazorpay();
    const rzp = new window.Razorpay!({
      key: c.keyId,
      order_id: c.orderId,
      amount: c.amount,
      currency: c.currency,
      name: "jobpilot",
      description: `${c.label} — ${c.credits} credits`,
      prefill: email ? { email } : undefined,
      theme: { color: "#15362b" },
      handler: async (r: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => {
        try {
          await jp.confirmRazorpay(r);
          toast.success(`${c.credits} credits added`);
          paid();
        } catch (e) {
          toast.error((e as Error).message);
        }
      },
      modal: { ondismiss: () => setBusy(null) },
    });
    rzp.on("payment.failed", () => toast.error("The payment didn't go through — nothing was charged"));
    rzp.open();
  };

  const buy = async (packId: string) => {
    setBusy(packId);
    try {
      const c = await jp.checkout(packId, currency);
      if (c.provider === "stripe") {
        window.location.href = c.url; // back to /?payment=success when done
        return;
      }
      await razorpay(c);
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(null);
    }
  };

  const data = packsQ.data;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md rounded-[20px] p-5">
        <DialogTitle className="text-[18px] font-bold tracking-tight text-foreground">Buy credits</DialogTitle>
        <p className="-mt-1 text-[13px] text-muted-foreground">
          One credit per application, only when it's sent — failed or cancelled ones are given back. Credits don't expire.
        </p>
        <div className="flex w-fit gap-1 rounded-full border border-border bg-card p-1">
          {(["INR", "USD"] as const).map((c) => (
            <button
              key={c}
              onClick={() => setCurrency(c)}
              className={`rounded-full px-3 py-1 text-[12px] font-semibold transition-colors ${
                currency === c ? "bg-foreground text-background" : "text-ink-2"
              }`}
            >
              {c === "INR" ? "₹ INR" : "$ USD"}
            </button>
          ))}
        </div>
        {packsQ.isLoading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-faint" />
          </div>
        ) : (
          <div className="space-y-2">
            {data?.packs.map((p) => (
              <button
                key={p.id}
                disabled={!data.enabled || !!busy}
                onClick={() => buy(p.id)}
                className="flex w-full items-center justify-between rounded-[16px] border border-border bg-card px-4 py-3 text-left transition-colors hover:border-faint disabled:opacity-60"
              >
                <span>
                  <span className="block text-[14px] font-semibold text-foreground">{p.label}</span>
                  <span className="text-[12px] text-muted-foreground">
                    {p.credits.toLocaleString()} credits · {formatMoney(Math.round(p.amount / p.credits), p.currency)} each
                  </span>
                </span>
                <span className="flex items-center gap-2 text-[14px] font-semibold text-foreground">
                  {busy === p.id && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {formatMoney(p.amount, p.currency)}
                </span>
              </button>
            ))}
            {data && !data.enabled && (
              <p className="rounded-xl bg-warning-soft px-3 py-2 text-[12px] text-warning-soft-foreground">
                Payments in {currency} aren't available yet.
              </p>
            )}
          </div>
        )}
        <p className="text-[11px] text-faint">
          Paid securely with {currency === "INR" ? "Razorpay (UPI, cards, netbanking)" : "Stripe (cards, Apple Pay, Google Pay)"}.
        </p>
      </DialogContent>
    </Dialog>
  );
}
