import type { WarrantyClaim } from '../domain/types.js';
import { Store } from '../store/store.js';

export class WarrantyClaimService {
  constructor(private readonly store: Store) {}

  settle(claimId: string): WarrantyClaim {
    const claim = this.store.warrantyClaims.get(claimId);
    if (!claim) throw new Error('claim not found');
    if (claim.status !== 'APPROVED' && claim.status !== 'SETTLED') throw new Error('claim is not payable');
    // BUG: every retry reads the mutable live rate and appends another financial effect.
    const rate = this.store.exchangeRates.get(claim.currency);
    if (!rate) throw new Error('exchange rate unavailable');
    claim.exchangeRate = rate;
    claim.localAmount = claim.foreignAmount * rate;
    claim.status = 'SETTLED';
    this.store.addLedger({ tenantId: claim.tenantId, account: 'warranty-settlement', referenceId: claim.id, amount: claim.localAmount, direction: 'CREDIT' });
    this.store.addAudit(claim.tenantId, 'warranty-claim.settled', 'claim', claim.id, { rate, localAmount: claim.localAmount });
    this.store.addOutbox(claim.tenantId, 'mro.warranty-settled', claim.workOrderId, { claimId: claim.id, amount: claim.localAmount });
    return claim;
  }
}
