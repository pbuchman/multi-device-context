import { liveDocumentQuery } from "../apps/web/src/queries.js";
import { readFile } from "node:fs/promises";

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  Timestamp,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import {
  deleteObject,
  getBytes,
  ref,
  uploadBytes,
} from "firebase/storage";
import { afterAll, afterEach, beforeAll, describe, it, expect } from "vitest";

const PROJECT_ID = "demo-mdc";
const OWNER = "owner_uid";
const OTHER = "other_uid";
const CONTEXT_ID = "00000000-0000-4000-8000-000000000001";
const SECOND_CONTEXT_ID = "00000000-0000-4000-8000-000000000003";
const ITEM_ID = "00000000-0000-4000-8000-000000000002";
const MAX_ATTACHMENT_BYTES = 104_857_600;

let environment: RulesTestEnvironment;

function contextPath(uid = OWNER, contextId = CONTEXT_ID) {
  return `users/${uid}/contexts/${contextId}`;
}

function itemPath(uid = OWNER, contextId = CONTEXT_ID, itemId = ITEM_ID) {
  return `${contextPath(uid, contextId)}/items/${itemId}`;
}

function objectPath(uid = OWNER, contextId = CONTEXT_ID, itemId = ITEM_ID) {
  return `${itemPath(uid, contextId, itemId)}/original`;
}

function contextRecord(overrides: Record<string, unknown> = {}) {
  return {
    title: "Shared context",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    deleting: false,
    ...overrides,
  };
}

function textItem(overrides: Record<string, unknown> = {}) {
  return {
    content: { kind: "text", text: "hello" },
    device: { id: "00000000-0000-4000-8000-000000000010", name: "Laptop" },
    createdAt: serverTimestamp(),
    ready: true,
    deleting: false,
    ...overrides,
  };
}

function attachmentItem(size = 4, contentType = "text/plain", overrides: Record<string, unknown> = {}) {
  return {
    content: { kind: "attachment", name: "note.txt", contentType, size },
    device: { id: "00000000-0000-4000-8000-000000000010", name: "Laptop" },
    createdAt: serverTimestamp(),
    ready: false,
    deleting: false,
    ...overrides,
  };
}

async function seed(
  path: string,
  data: Record<string, unknown>,
): Promise<void> {
  await environment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), path), {
      ...data,
      createdAt: data.createdAt ?? Timestamp.now(),
      updatedAt: data.updatedAt ?? Timestamp.now(),
    });
  });
}

beforeAll(async () => {
  if (process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:18080") {
    throw new Error("Refusing to run without the dedicated Firestore emulator");
  }
  if (process.env.FIREBASE_STORAGE_EMULATOR_HOST !== "127.0.0.1:19199") {
    throw new Error("Refusing to run without the dedicated Storage emulator");
  }
  environment = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      host: "127.0.0.1",
      port: 18080,
      rules: await readFile("infra/firestore.rules", "utf8"),
    },
    storage: {
      host: "127.0.0.1",
      port: 19199,
      rules: await readFile("infra/storage.rules", "utf8"),
    },
  });
});

afterEach(async () => {
  await environment.clearFirestore();
  await environment.clearStorage();
});

afterAll(async () => environment.cleanup());

describe("Firestore owner isolation and context validation", () => {
  it("allows v0.2 context metadata and manual titles but keeps job leases server-only", async () => {
    const owner = environment.authenticatedContext(OWNER).firestore();
    const batch = writeBatch(owner);
    batch.set(doc(owner, contextPath()), { ...contextRecord(), originDeviceId: CONTEXT_ID, firstItemId: ITEM_ID, ready: true, titleState: "pending" });
    batch.set(doc(owner, itemPath()), textItem());
    await assertSucceeds(batch.commit());
    await assertSucceeds(updateDoc(doc(owner, contextPath()), { title: "Manual context title", titleState: "manual", updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(owner, contextPath()), { titleState: "generated", updatedAt: serverTimestamp() }));
    await assertFails(setDoc(doc(owner, contextPath(OWNER, SECOND_CONTEXT_ID)), { ...contextRecord(), titleAttempts: 0 }));
    await assertFails(getDoc(doc(owner, `agentKeys/${CONTEXT_ID}`)));
  });

  it("R6: bounded existence reads handle absent, existing, deleting and foreign records", async () => {
    const owner = environment.authenticatedContext(OWNER).firestore();
    const contexts = collection(owner, `users/${OWNER}/contexts`);
    const find = () => getDocs(liveDocumentQuery(contexts, CONTEXT_ID));
    expect((await assertSucceeds(find())).empty).toBe(true);
    await setDoc(doc(owner, contextPath()), contextRecord());
    await setDoc(doc(owner, contextPath(OWNER, SECOND_CONTEXT_ID)), contextRecord());
    expect((await assertSucceeds(find())).docs.map(d => d.id)).toEqual([CONTEXT_ID]);
    const items = collection(owner, `${contextPath()}/items`);
    expect((await assertSucceeds(getDocs(liveDocumentQuery(items, ITEM_ID)))).empty).toBe(true);
    const other = environment.authenticatedContext(OTHER).firestore();
    await assertFails(getDocs(liveDocumentQuery(collection(other, `users/${OWNER}/contexts`), CONTEXT_ID)));
    await seed(contextPath(), contextRecord({ deleting: true }));
    expect((await assertSucceeds(find())).empty).toBe(true);
  });

  it("prevents old outboxes recreating deleted contexts while allowing new IDs", async () => {
    const marker = `users/${OWNER}/deletedContexts/${CONTEXT_ID}`;
    await seed(marker, { deleted: true });
    const owner = environment.authenticatedContext(OWNER).firestore();
    await assertSucceeds(getDoc(doc(owner, marker)));
    await assertFails(getDoc(doc(environment.authenticatedContext(OTHER).firestore(), marker)));
    await assertFails(deleteDoc(doc(owner, marker)));
    await assertFails(setDoc(doc(owner, marker), { deleted: false }));
    const batch = writeBatch(owner);
    batch.set(doc(owner, contextPath()), contextRecord());
    batch.set(doc(owner, itemPath()), textItem());
    await assertFails(batch.commit());
    await assertSucceeds(setDoc(doc(owner, contextPath(OWNER, SECOND_CONTEXT_ID)), contextRecord()));
  });
  it("allows owner create/get/list/update and denies unauthenticated or cross-user access", async () => {
    const owner = environment.authenticatedContext(OWNER).firestore();
    const other = environment.authenticatedContext(OTHER).firestore();
    const anonymous = environment.unauthenticatedContext().firestore();
    const reference = doc(owner, contextPath());

    await assertSucceeds(setDoc(reference, contextRecord()));
    await assertSucceeds(getDoc(reference));
    await assertSucceeds(
      getDocs(query(collection(owner, `users/${OWNER}/contexts`), where("deleting", "==", false))),
    );
    await assertSucceeds(updateDoc(reference, { title: "Renamed", updatedAt: serverTimestamp() }));
    await assertFails(getDoc(doc(other, contextPath())));
    await assertFails(
      getDocs(query(collection(other, `users/${OWNER}/contexts`), where("deleting", "==", false))),
    );
    await assertFails(updateDoc(doc(other, contextPath()), { title: "Attack", updatedAt: serverTimestamp() }));
    await assertFails(deleteDoc(doc(other, contextPath())));
    await assertFails(getDoc(doc(anonymous, contextPath())));
    await assertFails(setDoc(doc(anonymous, contextPath(OWNER, SECOND_CONTEXT_ID)), contextRecord()));
    await assertFails(setDoc(doc(other, contextPath(OWNER, SECOND_CONTEXT_ID)), contextRecord()));
    await assertFails(deleteDoc(reference));
  });

  it("rejects invalid, unknown, immutable, and client deletion fields", async () => {
    const owner = environment.authenticatedContext(OWNER).firestore();
    const reference = doc(owner, contextPath());
    await assertFails(setDoc(reference, contextRecord({ title: "   " })));
    await assertFails(setDoc(reference, contextRecord({ title: "x".repeat(161) })));
    await assertFails(setDoc(reference, contextRecord({ extra: true })));
    await assertFails(setDoc(reference, contextRecord({ deleting: true })));
    await assertSucceeds(setDoc(reference, contextRecord()));
    await assertFails(updateDoc(reference, { createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(reference, { deleting: true, updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(reference, { title: "No timestamp" }));
  });

  it("makes deleting contexts unavailable and requires live-only list queries", async () => {
    await seed(contextPath(), { title: "Deleting", deleting: true });
    await seed(contextPath(OWNER, SECOND_CONTEXT_ID), { title: "Live", deleting: false });
    const owner = environment.authenticatedContext(OWNER).firestore();
    await assertFails(getDoc(doc(owner, contextPath())));
    await assertFails(getDocs(collection(owner, `users/${OWNER}/contexts`)));
    await assertSucceeds(
      getDocs(query(collection(owner, `users/${OWNER}/contexts`), where("deleting", "==", false))),
    );
  });
});

describe("Firestore item validation and lifecycle", () => {
  it("prevents a delayed outbox from recreating an individually deleted item", async () => {
    await seed(contextPath(), { title: "Context", deleting: false });
    const marker = `users/${OWNER}/deletedItems/${CONTEXT_ID}_${ITEM_ID}`;
    await seed(marker, { deleted: true });
    const owner = environment.authenticatedContext(OWNER).firestore();
    await assertSucceeds(getDoc(doc(owner, marker)));
    await assertFails(getDoc(doc(environment.authenticatedContext(OTHER).firestore(), marker)));
    await assertFails(deleteDoc(doc(owner, marker)));
    await assertFails(setDoc(doc(owner, marker), { deleted: false }));
    await assertFails(setDoc(doc(owner, itemPath()), textItem()));
    await assertSucceeds(setDoc(doc(owner, itemPath(OWNER, CONTEXT_ID, SECOND_CONTEXT_ID)), textItem()));
  });
  it("supports atomic parent/item creation with getAfter and rejects missing or deleting parents", async () => {
    const owner = environment.authenticatedContext(OWNER).firestore();
    const batch = writeBatch(owner);
    batch.set(doc(owner, contextPath()), contextRecord());
    batch.set(doc(owner, itemPath()), textItem());
    await assertSucceeds(batch.commit());

    await assertFails(setDoc(doc(owner, itemPath(OWNER, SECOND_CONTEXT_ID)), textItem()));
    await seed(contextPath(OWNER, SECOND_CONTEXT_ID), {
      title: "Deleting",
      deleting: true,
    });
    await assertFails(setDoc(doc(owner, itemPath(OWNER, SECOND_CONTEXT_ID)), textItem()));
  });

  it("allows owner get/list/create while denying cross-user, mutation, and deletion", async () => {
    await seed(contextPath(), { title: "Context", deleting: false });
    const owner = environment.authenticatedContext(OWNER).firestore();
    const other = environment.authenticatedContext(OTHER).firestore();
    const anonymous = environment.unauthenticatedContext().firestore();
    const reference = doc(owner, itemPath());
    await assertSucceeds(setDoc(reference, textItem()));
    await assertSucceeds(getDoc(reference));
    await assertSucceeds(
      getDocs(query(collection(owner, `${contextPath()}/items`), where("deleting", "==", false))),
    );
    await assertFails(getDoc(doc(other, itemPath())));
    await assertFails(
      getDocs(query(collection(other, `${contextPath()}/items`), where("deleting", "==", false))),
    );
    await assertFails(getDoc(doc(anonymous, itemPath())));
    await assertFails(setDoc(doc(other, itemPath()), textItem()));
    await assertFails(updateDoc(reference, { ready: false }));
    await assertFails(updateDoc(reference, { content: { kind: "text", text: "changed" } }));
    await assertFails(deleteDoc(reference));
  });

  it("enforces exact fields, variants, device metadata, and ready state", async () => {
    await seed(contextPath(), { title: "Context", deleting: false });
    const owner = environment.authenticatedContext(OWNER).firestore();
    const reference = doc(owner, itemPath());
    await assertFails(setDoc(reference, textItem({ extra: true })));
    await assertFails(setDoc(reference, textItem({ ready: false })));
    await assertFails(setDoc(reference, textItem({ deleting: true })));
    await assertFails(setDoc(reference, textItem({ content: { kind: "text", text: "ok", extra: true } })));
    await assertFails(setDoc(reference, textItem({ device: { id: "not-a-uuid", name: "Laptop" } })));
    await assertFails(setDoc(reference, attachmentItem(4, "invalid mime")));
    await assertFails(
      setDoc(reference, attachmentItem(4, "text/plain", {
        content: { kind: "attachment", name: "../note.txt", contentType: "text/plain", size: 4 },
      })),
    );
    await assertFails(setDoc(reference, attachmentItem(4, "text/plain", { ready: true })));
    await assertFails(
      setDoc(reference, attachmentItem(MAX_ATTACHMENT_BYTES + 1, "application/octet-stream")),
    );
    await assertSucceeds(setDoc(reference, attachmentItem()));
    await assertFails(updateDoc(reference, { ready: true }));
  });

  it("enforces the UTF-8 byte boundary for non-ASCII text", async () => {
    await seed(contextPath(), { title: "Context", deleting: false });
    const owner = environment.authenticatedContext(OWNER).firestore();
    await assertSucceeds(
      setDoc(doc(owner, itemPath()), textItem({ content: { kind: "text", text: "é".repeat(131_072) } })),
    );
    await assertFails(
      setDoc(
        doc(owner, itemPath(OWNER, CONTEXT_ID, "00000000-0000-4000-8000-000000000004")),
        textItem({ content: { kind: "text", text: "é".repeat(131_073) } }),
      ),
    );
  });

  it("makes items unavailable when the item or its parent is deleting", async () => {
    await seed(contextPath(), { title: "Context", deleting: false });
    await seed(itemPath(), { ...textItem(), createdAt: Timestamp.now(), deleting: true });
    const owner = environment.authenticatedContext(OWNER).firestore();
    await assertFails(getDoc(doc(owner, itemPath())));

    await seed(itemPath(), { ...textItem(), createdAt: Timestamp.now(), deleting: false });
    await seed(contextPath(), { title: "Context", deleting: true });
    await assertFails(getDoc(doc(owner, itemPath())));
    await assertFails(getDocs(collection(owner, `${contextPath()}/items`)));
  });
});

describe("Storage attachment lifecycle", () => {
  async function seedPending(size = 4, contentType = "text/plain") {
    await seed(contextPath(), { title: "Context", deleting: false });
    await seed(itemPath(), {
      ...attachmentItem(size, contentType),
      createdAt: Timestamp.now(),
    });
  }

  it("allows create-only owner upload, then only authenticated ready reads", async () => {
    await seedPending();
    const owner = environment.authenticatedContext(OWNER).storage();
    const other = environment.authenticatedContext(OTHER).storage();
    const anonymous = environment.unauthenticatedContext().storage();
    const reference = ref(owner, objectPath());
    await assertFails(
      uploadBytes(ref(other, objectPath()), new TextEncoder().encode("data"), { contentType: "text/plain" }),
    );
    await assertSucceeds(uploadBytes(reference, new TextEncoder().encode("data"), { contentType: "text/plain" }));
    await assertFails(getBytes(reference));
    await seed(itemPath(), {
      ...attachmentItem(4, "text/plain", { ready: true }),
      createdAt: Timestamp.now(),
    });
    await assertSucceeds(getBytes(reference));
    await assertFails(getBytes(ref(other, objectPath())));
    await assertFails(getBytes(ref(anonymous, objectPath())));
    await assertFails(uploadBytes(reference, new TextEncoder().encode("data"), { contentType: "text/plain" }));
    await assertFails(deleteObject(reference));
  });

  it("accepts Firebase upload token metadata while keeping pending authenticated reads blocked", async () => {
    const tokenItem = "00000000-0000-4000-8000-000000000099";
    await seed(contextPath(), { title: "Context", deleting: false });
    await seed(itemPath(OWNER, CONTEXT_ID, tokenItem), { ...attachmentItem(), createdAt: Timestamp.now() });
    const owner = environment.authenticatedContext(OWNER).storage();
    const reference = ref(owner, objectPath(OWNER, CONTEXT_ID, tokenItem));
    await assertSucceeds(uploadBytes(reference, new TextEncoder().encode("data"), {
      contentType: "text/plain",
      customMetadata: { firebaseStorageDownloadTokens: "synthetic-upload-token" },
    }));
    await assertFails(getBytes(reference));
    await assertFails(uploadBytes(reference, new TextEncoder().encode("data"), { contentType: "text/plain" }));
  });

  it("denies mismatched metadata, wrong paths, deleting records, and over-limit bytes", async () => {
    await seedPending();
    const owner = environment.authenticatedContext(OWNER).storage();
    await assertFails(
      uploadBytes(ref(owner, objectPath()), new TextEncoder().encode("bad"), { contentType: "text/plain" }),
    );
    await assertFails(
      uploadBytes(ref(owner, objectPath()), new TextEncoder().encode("data"), {
        contentType: "application/octet-stream",
      }),
    );
    await assertFails(
      uploadBytes(ref(owner, `${itemPath()}/preview`), new TextEncoder().encode("data"), {
        contentType: "text/plain",
      }),
    );

    await seed(itemPath(), {
      ...attachmentItem(4, "text/plain", { deleting: true }),
      createdAt: Timestamp.now(),
    });
    await assertFails(
      uploadBytes(ref(owner, objectPath()), new TextEncoder().encode("data"), { contentType: "text/plain" }),
    );

    await seed(contextPath(), { title: "Context", deleting: false });
    await seed(itemPath(), {
      ...attachmentItem(MAX_ATTACHMENT_BYTES + 1, "application/octet-stream"),
      createdAt: Timestamp.now(),
    });
    await assertFails(
      uploadBytes(ref(owner, objectPath()), new Uint8Array(MAX_ATTACHMENT_BYTES + 1), {
        contentType: "application/octet-stream",
      }),
    );
  });
});
