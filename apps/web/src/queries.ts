import { documentId, limit, query, where, type CollectionReference } from "firebase/firestore";

/** One document at most, while retaining collection-query rules for absent IDs. */
export function liveDocumentQuery(collection: CollectionReference, id: string) {
  // ID equality is evaluated against a null resource for absent documents. A
  // closed ID range keeps missing/deleting results empty under the list rules.
  return query(collection, where("deleting", "==", false),
    where(documentId(), ">=", id), where(documentId(), "<=", id), limit(1));
}
