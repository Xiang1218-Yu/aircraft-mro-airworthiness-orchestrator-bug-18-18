import type {
  AuditRecord,
  CertificateRecord,
  CoreReturn,
  CustomsDeclaration,
  ExchangeRateSnapshot,
  InstalledPart,
  LedgerEntry,
  OutboxMessage,
  PartStock,
  Reservation,
  WorkOrder,
  ExternalEvent,
} from '../domain/types.js';

class Mutex {
  private tail = Promise.resolve();

  async runExclusive<T>(work: () => Promise<T> | T): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

export class Store {
  readonly stocks = new Map<string, PartStock>();
  readonly workOrders = new Map<string, WorkOrder>();
  readonly reservations = new Map<string, Reservation>();
  readonly certificates = new Map<string, CertificateRecord>();
  readonly customs = new Map<string, CustomsDeclaration>();
  readonly coreReturns = new Map<string, CoreReturn>();
  readonly installedParts = new Map<string, InstalledPart>();
  readonly outbox: OutboxMessage[] = [];
  readonly audit: AuditRecord[] = [];
  readonly ledger: LedgerEntry[] = [];
  readonly externalEvents = new Map<string, ExternalEvent>();
  readonly lock = new Mutex();
  private sequence = 0;

  nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_${this.sequence.toString().padStart(6, '0')}`;
  }

  now(): string {
    return new Date().toISOString();
  }

  addAudit(tenantId: string, action: string, entity: string, entityId: string, metadata: Record<string, string | number | boolean> = {}): void {
    this.audit.push({ id: this.nextId('audit'), tenantId, action, entity, entityId, metadata, createdAt: this.now() });
  }

  addOutbox(tenantId: string, topic: string, aggregateId: string, payload: unknown): void {
    this.outbox.push({ id: this.nextId('outbox'), tenantId, topic, aggregateId, payload: JSON.stringify(payload), status: 'PENDING', createdAt: this.now() });
  }

  /** Append a ledger entry only if no entry exists for the same account/reference (idempotent on retries). */
  addLedgerOnce(entry: Omit<LedgerEntry, 'id' | 'createdAt'>): boolean {
    const exists = this.ledger.some((e) => e.account === entry.account && e.referenceId === entry.referenceId);
    if (exists) return false;
    this.addLedger(entry);
    return true;
  }

  /** Append an outbox message only if the same topic/aggregate/payload was not already enqueued. */
  addOutboxOnce(tenantId: string, topic: string, aggregateId: string, payload: unknown): boolean {
    const serialized = JSON.stringify(payload);
    const exists = this.outbox.some((m) => m.topic === topic && m.aggregateId === aggregateId && m.payload === serialized);
    if (exists) return false;
    this.outbox.push({ id: this.nextId('outbox'), tenantId, topic, aggregateId, payload: serialized, status: 'PENDING', createdAt: this.now() });
    return true;
  }

  addLedger(entry: Omit<LedgerEntry, 'id' | 'createdAt'>): void {
    this.ledger.push({ ...entry, id: this.nextId('ledger'), createdAt: this.now() });
  }

  readonly warrantyClaims = new Map<string, import('../domain/types.js').WarrantyClaim>();
  readonly exchangeRates = new Map<string, number>();
  readonly exchangeRateSnapshots = new Map<string, ExchangeRateSnapshot>();
}
