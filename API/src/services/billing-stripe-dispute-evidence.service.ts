import type Stripe from 'stripe';

import { AppError } from '../utils/errors.js';

export function disputePrincipalMovement(dispute: Stripe.Dispute, reinstated: boolean): number {
  const movement = dispute.balance_transactions.reduce((total, transaction) => {
    const relevant = reinstated ? transaction.amount > 0 : transaction.amount < 0;
    if (!relevant) return total;
    const absolute = Math.abs(transaction.amount);
    if (transaction.currency.toLowerCase() === dispute.currency.toLowerCase()) {
      return total + absolute;
    }
    if (!transaction.exchange_rate || transaction.exchange_rate <= 0) {
      throw new AppError('INTERNAL', 503, 'STRIPE_CREDIT_DISPUTE_FX_PROOF_MISSING');
    }
    return total + Math.round(absolute / transaction.exchange_rate);
  }, 0);
  const principal = Math.min(movement, dispute.amount);
  if (!Number.isSafeInteger(principal) || principal <= 0) {
    throw new AppError('INTERNAL', 503, 'STRIPE_CREDIT_DISPUTE_MOVEMENT_PENDING');
  }
  return principal;
}

export function disputeProof(dispute: Stripe.Dispute): string {
  return dispute.balance_transactions
    .map(
      (transaction) =>
        `${transaction.id}:${transaction.amount}:${transaction.currency}:${transaction.exchange_rate ?? 'none'}`,
    )
    .sort()
    .join('|');
}

