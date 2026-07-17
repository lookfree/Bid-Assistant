import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import {
  type AccountStatus,
  type FeedbackStatus,
  type LedgerType,
  type MemberTier,
  type OrderStatus,
  type ReconcileStatus,
  feedbackStatusLabel,
  ledgerTypeLabel,
  orderStatusLabel,
  tierLabel,
} from "@/lib/mock-data"

export function TierBadge({ tier }: { tier: MemberTier }) {
  const styles: Record<MemberTier, string> = {
    free: "bg-muted text-muted-foreground",
    personal: "bg-sky-100 text-sky-700",
    pro: "bg-primary/10 text-primary",
  }
  return (
    <Badge variant="secondary" className={cn("font-medium", styles[tier])}>
      {tierLabel[tier]}
    </Badge>
  )
}

export function AccountStatusBadge({ status }: { status: AccountStatus }) {
  return status === "active" ? (
    <Badge variant="secondary" className="bg-emerald-100 text-emerald-700">
      正常
    </Badge>
  ) : (
    <Badge variant="secondary" className="bg-destructive/10 text-destructive">
      已封禁
    </Badge>
  )
}

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  const styles: Record<OrderStatus, string> = {
    paid: "bg-emerald-100 text-emerald-700",
    pending: "bg-amber-100 text-amber-700",
    refunded: "bg-muted text-muted-foreground",
    failed: "bg-destructive/10 text-destructive",
    unknown: "bg-orange-100 text-orange-700",
  }
  return (
    <Badge variant="secondary" className={styles[status]}>
      {orderStatusLabel[status]}
    </Badge>
  )
}

export function ReconcileBadge({ status }: { status: ReconcileStatus }) {
  return status === "matched" ? (
    <Badge variant="secondary" className="bg-emerald-100 text-emerald-700">
      已对平
    </Badge>
  ) : (
    <Badge variant="secondary" className="bg-amber-100 text-amber-700">
      差异
    </Badge>
  )
}

export function LedgerTypeBadge({ type }: { type: LedgerType }) {
  const styles: Record<LedgerType, string> = {
    grant: "bg-sky-100 text-sky-700",
    purchase: "bg-emerald-100 text-emerald-700",
    hold: "bg-amber-100 text-amber-700",
    settle: "bg-primary/10 text-primary",
    release: "bg-violet-100 text-violet-700",
    expire: "bg-muted text-muted-foreground",
    referral_reward: "bg-pink-100 text-pink-700",
    refund_clawback: "bg-orange-100 text-orange-700",
    admin_adjust: "bg-indigo-100 text-indigo-700",
  }
  return (
    <Badge variant="secondary" className={cn("font-mono", styles[type])}>
      {ledgerTypeLabel[type]}
    </Badge>
  )
}

export function FeedbackStatusBadge({ status }: { status: FeedbackStatus }) {
  const styles: Record<FeedbackStatus, string> = {
    pending: "bg-amber-100 text-amber-700",
    processing: "bg-sky-100 text-sky-700",
    resolved: "bg-emerald-100 text-emerald-700",
  }
  return (
    <Badge variant="secondary" className={styles[status]}>
      {feedbackStatusLabel[status]}
    </Badge>
  )
}
