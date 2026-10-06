import type { ExchangeRateSnapshot, WarrantyClaim } from '../domain/types.js';
import { Store } from '../store/store.js';

const LEDGER_ACCOUNT = 'warranty-settlement';

export class WarrantyClaimService {
  constructor(private readonly store: Store) {}

  /**
   * Approval is the single point where the FX rate is locked. The live rate is read
   * exactly once and persisted as an immutable snapshot together with the local amount.
   */
  approve(claimId: string): WarrantyClaim {
    const claim = this.requireClaim(claimId);
    if (claim.status === 'APPROVED' || claim.status === 'SETTLED') return claim;
    if (claim.status !== 'SUBMITTED') {
      this.recordStaleCallback(claim, 'approve');
      return claim;
    }

    const rate = this.store.exchangeRates.get(claim.currency);
    if (rate === undefined) throw new Error('exchange rate unavailable');

    const snapshot: ExchangeRateSnapshot = {
      id: this.store.nextId('fxrate'),
      tenantId: claim.tenantId,
      claimId: claim.id,
      currency: claim.currency,
      rate,
      capturedAt: this.store.now(),
    };
    this.store.exchangeRateSnapshots.set(snapshot.id, snapshot);

    claim.rateSnapshotId = snapshot.id;
    claim.exchangeRate = rate;
    claim.localAmount = claim.foreignAmount * rate;
    claim.approvedAt = snapshot.capturedAt;
    claim.status = 'APPROVED';

    this.store.addAudit(claim.tenantId, 'warranty-claim.approved', 'claim', claim.id, {
      rateSnapshotId: snapshot.id,
      rate,
      localAmount: claim.localAmount,
    });
    return claim;
  }

  /**
   * Settlement consumes the approval-time snapshot only. It never touches the live
   * rate table, and every side effect (ledger, audit, outbox) is idempotent so
   * retries and duplicated callbacks cannot create a second financial flow.
   */
  settle(claimId: string): WarrantyClaim {
    const claim = this.requireClaim(claimId);

    // Duplicate settle callback/retry: return the settled state verbatim, no reads, no writes.
    if (claim.status === 'SETTLED') return claim;

    if (claim.status !== 'APPROVED') {
      // Callback arrived after rejection/withdrawal: must not resurrect or alter the outcome.
      this.recordStaleCallback(claim, 'settle');
      return claim;
    }

    const snapshot = claim.rateSnapshotId ? this.store.exchangeRateSnapshots.get(claim.rateSnapshotId) : undefined;
    if (!snapshot || claim.localAmount === undefined || claim.exchangeRate !== snapshot.rate) {
      throw new Error('claim is missing its approval exchange-rate snapshot');
    }

    claim.status = 'SETTLED';
    claim.settledAt = this.store.now();

    const localAmount = claim.foreignAmount * snapshot.rate;
    if (localAmount !== claim.localAmount) {
      // Snapshot is immutable; the bound local amount must agree with it.
      throw new Error('local amount does not match the frozen exchange-rate snapshot');
    }

    const ledgerCreated = this.store.addLedgerOnce({
      tenantId: claim.tenantId,
      account: LEDGER_ACCOUNT,
      referenceId: claim.id,
      amount: claim.localAmount,
      direction: 'CREDIT',
    });
    this.store.addOutboxOnce(claim.tenantId, 'mro.warranty-settled', claim.workOrderId, {
      claimId: claim.id,
      rateSnapshotId: snapshot.id,
      amount: claim.localAmount,
    });
    if (ledgerCreated) {
      this.store.addAudit(claim.tenantId, 'warranty-claim.settled', 'claim', claim.id, {
        rateSnapshotId: snapshot.id,
        rate: snapshot.rate,
        localAmount: claim.localAmount,
      });
    }
    return claim;
  }

  reject(claimId: string): WarrantyClaim {
    const claim = this.requireClaim(claimId);
    if (claim.status === 'REJECTED') return claim;
    if (claim.status === 'SETTLED') {
      this.recordStaleCallback(claim, 'reject');
      return claim;
    }
    if (claim.status !== 'SUBMITTED' && claim.status !== 'APPROVED') {
      this.recordStaleCallback(claim, 'reject');
      return claim;
    }
    claim.status = 'REJECTED';
    this.store.addAudit(claim.tenantId, 'warranty-claim.rejected', 'claim', claim.id, {});
    return claim;
  }

  withdraw(claimId: string): WarrantyClaim {
    const claim = this.requireClaim(claimId);
    if (claim.status === 'WITHDRAWN') return claim;
    if (claim.status === 'SETTLED') {
      this.recordStaleCallback(claim, 'withdraw');
      return claim;
    }
    if (claim.status !== 'SUBMITTED' && claim.status !== 'APPROVED') {
      this.recordStaleCallback(claim, 'withdraw');
      return claim;
    }
    claim.status = 'WITHDRAWN';
    this.store.addAudit(claim.tenantId, 'warranty-claim.withdrawn', 'claim', claim.id, {});
    return claim;
  }

  private requireClaim(claimId: string): WarrantyClaim {
    const claim = this.store.warrantyClaims.get(claimId);
    if (!claim) throw new Error('claim not found');
    return claim;
  }

  private recordStaleCallback(claim: WarrantyClaim, attemptedAction: string): void {
    const alreadyRecorded = this.store.audit.some(
      (a) => a.entity === 'claim' && a.entityId === claim.id && a.action === 'warranty-claim.stale-callback'
        && a.metadata.attemptedAction === attemptedAction && a.metadata.status === claim.status,
    );
    if (!alreadyRecorded) {
      this.store.addAudit(claim.tenantId, 'warranty-claim.stale-callback', 'claim', claim.id, {
        attemptedAction,
        status: claim.status,
      });
    }
  }
}
