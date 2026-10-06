import type { WarrantyCallback, WarrantyClaim } from '../domain/types.js';
import { Store } from '../store/store.js';

const LEDGER_ACCOUNT = 'warranty-settlement';

export class WarrantyClaimService {
  constructor(private readonly store: Store) {}

  submit(tenantId: string, workOrderId: string, currency: string, foreignAmount: number): WarrantyClaim {
    const claim: WarrantyClaim = {
      id: this.store.nextId('warranty'),
      tenantId,
      workOrderId,
      currency,
      foreignAmount,
      status: 'SUBMITTED',
      processedCallbackIds: [],
      version: 1,
    };
    this.store.warrantyClaims.set(claim.id, claim);
    this.store.addAudit(tenantId, 'warranty-claim.submitted', 'claim', claim.id, { currency, foreignAmount });
    this.store.addOutbox(tenantId, 'mro.warranty-submitted', workOrderId, { claimId: claim.id, currency, foreignAmount });
    return claim;
  }

  /**
   * Approves a claim and locks the exchange-rate snapshot. The live rate is
   * read exactly once here; every later retry or settlement uses this snapshot.
   */
  approve(claimId: string, at: string = this.store.now(), source: string = 'exchange-rate-service'): WarrantyClaim {
    const claim = this.requireClaim(claimId);
    if (claim.status === 'APPROVED') return claim;
    if (claim.status !== 'SUBMITTED') {
      this.auditStale(claim, 'approve', at);
      return claim;
    }
    // Read and validate the live rate before mutating anything, so a missing
    // rate leaves the claim (and snapshot/audit/outbox) untouched.
    const rate = this.store.exchangeRates.get(claim.currency);
    if (rate === undefined) throw new Error('exchange rate unavailable');
    const snapshot = {
      id: this.store.nextId('fxrate'),
      tenantId: claim.tenantId,
      claimId: claim.id,
      currency: claim.currency,
      rate,
      source,
      lockedAt: at,
    };
    this.store.rateSnapshots.set(snapshot.id, snapshot);
    claim.rateSnapshotId = snapshot.id;
    claim.exchangeRate = rate;
    claim.status = 'APPROVED';
    claim.version += 1;
    this.store.addAudit(claim.tenantId, 'warranty-claim.approved', 'claim', claim.id, { rateSnapshotId: snapshot.id, rate });
    this.store.addOutbox(claim.tenantId, 'mro.warranty-approved', claim.workOrderId, { claimId: claim.id, rateSnapshotId: snapshot.id, rate });
    return claim;
  }

  reject(claimId: string, at: string = this.store.now()): WarrantyClaim {
    const claim = this.requireClaim(claimId);
    if (claim.status === 'REJECTED') return claim;
    if (claim.status !== 'SUBMITTED') {
      this.auditStale(claim, 'reject', at);
      return claim;
    }
    claim.status = 'REJECTED';
    claim.version += 1;
    this.store.addAudit(claim.tenantId, 'warranty-claim.rejected', 'claim', claim.id, {});
    this.store.addOutbox(claim.tenantId, 'mro.warranty-rejected', claim.workOrderId, { claimId: claim.id });
    return claim;
  }

  withdraw(claimId: string, at: string = this.store.now()): WarrantyClaim {
    const claim = this.requireClaim(claimId);
    if (claim.status === 'WITHDRAWN') return claim;
    if (claim.status !== 'SUBMITTED' && claim.status !== 'APPROVED') {
      this.auditStale(claim, 'withdraw', at);
      return claim;
    }
    claim.status = 'WITHDRAWN';
    claim.version += 1;
    this.store.addAudit(claim.tenantId, 'warranty-claim.withdrawn', 'claim', claim.id, {});
    this.store.addOutbox(claim.tenantId, 'mro.warranty-withdrawn', claim.workOrderId, { claimId: claim.id });
    return claim;
  }

  /**
   * Settles an approved claim from its approval-time rate snapshot. Retries
   * and duplicate callbacks are idempotent: the live rate is never re-read and
   * the ledger entry, audit record and outbox message are written at most once.
   */
  settle(claimId: string, at: string = this.store.now()): WarrantyClaim {
    const claim = this.requireClaim(claimId);
    if (claim.status === 'SETTLED') return claim;
    if (claim.status !== 'APPROVED' || !claim.rateSnapshotId) {
      this.auditStale(claim, 'settle', at);
      return claim;
    }
    const snapshot = this.store.rateSnapshots.get(claim.rateSnapshotId);
    if (!snapshot) throw new Error('rate snapshot missing for approved claim');
    const localAmount = this.toLocal(claim.foreignAmount, snapshot.rate);

    // All validation happens before any write; from here onward the claim,
    // snapshot, ledger, audit and outbox move together.
    claim.localAmount = localAmount;
    claim.exchangeRate = snapshot.rate;
    claim.status = 'SETTLED';
    claim.version += 1;
    if (!this.store.findLedger(LEDGER_ACCOUNT, claim.id)) {
      this.store.addLedger({ tenantId: claim.tenantId, account: LEDGER_ACCOUNT, referenceId: claim.id, amount: localAmount, direction: 'CREDIT' });
    }
    this.store.addAudit(claim.tenantId, 'warranty-claim.settled', 'claim', claim.id, { rateSnapshotId: snapshot.id, rate: snapshot.rate, localAmount });
    this.store.addOutbox(claim.tenantId, 'mro.warranty-settled', claim.workOrderId, { claimId: claim.id, rateSnapshotId: snapshot.id, amount: localAmount });
    return claim;
  }

  /**
   * Applies an external review/settlement callback. Redelivered callbacks with
   * the same callbackId are ignored; callbacks arriving after a terminal state
   * (rejected/withdrawn/settled) are recorded as stale and never mutate it.
   */
  applyCallback(callback: WarrantyCallback): 'APPLIED' | 'DUPLICATE' | 'STALE' {
    const claim = this.requireClaim(callback.claimId);
    if (claim.processedCallbackIds.includes(callback.callbackId)) return 'DUPLICATE';

    const before = claim.status;
    if (callback.action === 'APPROVE') this.approve(claim.id, callback.receivedAt);
    else if (callback.action === 'REJECT') this.reject(claim.id, callback.receivedAt);
    else if (callback.action === 'WITHDRAW') this.withdraw(claim.id, callback.receivedAt);
    else this.settle(claim.id, callback.receivedAt);

    claim.processedCallbackIds.push(callback.callbackId);
    return claim.status === before ? 'STALE' : 'APPLIED';
  }

  private requireClaim(claimId: string): WarrantyClaim {
    const claim = this.store.warrantyClaims.get(claimId);
    if (!claim) throw new Error('claim not found');
    return claim;
  }

  private auditStale(claim: WarrantyClaim, action: string, at: string): void {
    this.store.addAudit(claim.tenantId, 'warranty-claim.stale-callback', 'claim', claim.id, { action, status: claim.status, at });
  }

  private toLocal(foreignAmount: number, rate: number): number {
    const cents = Math.round((foreignAmount * rate) * 100);
    return cents / 100;
  }
}
