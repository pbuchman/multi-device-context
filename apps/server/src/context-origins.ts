import { ContextOriginSchema, ContextOriginsRequestSchema, DeviceSchema, IdSchema, type AccessDevice, type ContextOrigin } from "@mdc/contracts";
import { FieldPath, type DocumentSnapshot, type Firestore, type Transaction } from "firebase-admin/firestore";
import { accessDevice, DeviceUnauthorized, type DeviceIdentity } from "./device-access.js";

export interface ContextOriginsPort {
  get(identity: DeviceIdentity, contextIds: string[]): Promise<{ records: ContextOrigin[] }>;
}

const paletteSize = 8;
const unknownName = "Unknown device";

function paletteCounts(data: FirebaseFirestore.DocumentData | undefined): number[] {
  if (!data) return Array<number>(paletteSize).fill(0);
  const counts: unknown = data.counts;
  if (!Array.isArray(counts) || counts.length !== paletteSize || counts.some(count => !Number.isSafeInteger(count) || count < 0)) {
    throw new Error("Invalid origin palette metadata");
  }
  return [...counts] as number[];
}

function sourceName(data: FirebaseFirestore.DocumentData | undefined, originId: string): string | undefined {
  const source = data?.deleting === false ? DeviceSchema.safeParse(data.device) : undefined;
  return source?.success && source.data.id === originId ? source.data.name : undefined;
}

/** Colors live outside strict public device/history documents and survive source deletion. */
export class ContextOriginsStore implements ContextOriginsPort {
  constructor(private readonly db: Firestore) {}

  async get(identity: DeviceIdentity, contextIds: string[]): Promise<{ records: ContextOrigin[] }> {
    const input = ContextOriginsRequestSchema.parse({ contextIds });
    const ids = [...new Set(input.contextIds)];
    return this.db.runTransaction(async tx => {
      const deviceRef = this.db.doc(`users/${identity.uid}/devices/${identity.deviceId}`);
      const [deviceSnapshot, contexts] = await Promise.all([
        tx.get(deviceRef),
        ids.length ? tx.getAll(...ids.map(id => this.db.doc(`users/${identity.uid}/contexts/${id}`)), { fieldMask: ["originDeviceId", "deleting", "firstItemId"] }) : Promise.resolve([]),
      ]);
      // Authentication happened before this transaction. Re-read the live grant so a
      // policy change/removal racing that authentication cannot disclose other origins.
      let device: AccessDevice;
      try { device = accessDevice(identity.deviceId, deviceSnapshot.data()); } catch { throw new DeviceUnauthorized(); }
      const visible = contexts.filter(context => {
        const data = context.data();
        return data?.deleting === false && (device.mode === "all" || data.originDeviceId === device.id);
      });
      const origins = new Map<string, DocumentSnapshot[]>();
      for (const context of visible) {
        const parsed = IdSchema.safeParse(context.data()?.originDeviceId);
        // Surviving items cannot establish the origin of pre-origin contexts.
        if (parsed.success) origins.set(parsed.data, [...(origins.get(parsed.data) ?? []), context]);
      }
      if (!origins.size) return { records: [] };

      const originIds = [...origins.keys()].sort();
      const accountRef = this.db.doc(`internalContextOriginAccounts/${identity.uid}`);
      const allocationRefs = originIds.map(id => accountRef.collection("origins").doc(id));
      const [account, allocations, registered] = await Promise.all([
        tx.get(accountRef),
        tx.getAll(...allocationRefs),
        tx.getAll(...originIds.map(id => this.db.doc(`users/${identity.uid}/devices/${id}`)), { fieldMask: ["name"] }),
      ]);
      const names = await Promise.all(originIds.map(async (id, index) => {
        const current = DeviceSchema.safeParse({ id, name: registered[index]?.data()?.name });
        if (current.success) return current.data.name;
        // Only requested, visible contexts participate in fallback. Each lookup reads
        // at most the named first item and one indexed surviving matching-source item.
        for (const context of origins.get(id)!) {
          const name = await this.legacyName(tx, context, id);
          if (name !== undefined) return name;
        }
        return unknownName;
      }));
      const counts = paletteCounts(account.data());
      let allocated = false;
      const records = originIds.map((id, index) => {
        const allocation = allocations[index]!;
        let colorIndex: number;
        if (allocation.exists) {
          colorIndex = ContextOriginSchema.shape.colorIndex.parse(allocation.data()?.colorIndex);
        } else {
          colorIndex = counts.indexOf(Math.min(...counts));
          counts[colorIndex] = counts[colorIndex]! + 1;
          tx.create(allocationRefs[index]!, { colorIndex });
          allocated = true;
        }
        return { id, name: names[index]!, colorIndex };
      });
      // This shared document serializes allocations for different origin IDs as well
      // as simultaneous requests for the same source, without scanning old assignments.
      if (allocated) tx.set(accountRef, { counts });
      return { records };
    });
  }

  private async legacyName(tx: Transaction, context: DocumentSnapshot, originId: string): Promise<string | undefined> {
    const first = IdSchema.safeParse(context.data()?.firstItemId);
    if (first.success) {
      const [snapshot] = await tx.getAll(context.ref.collection("items").doc(first.data), { fieldMask: ["device", "deleting"] });
      const name = sourceName(snapshot?.data(), originId);
      if (name !== undefined) return name;
    }
    const surviving = await tx.get(context.ref.collection("items")
      .where("deleting", "==", false).where("device.id", "==", originId)
      .orderBy("createdAt").orderBy(FieldPath.documentId()).select("device", "deleting").limit(1));
    return sourceName(surviving.docs[0]?.data(), originId);
  }
}
