import type { Firestore } from "firebase-admin/firestore";
export type UserSettings = { aiTitlesEnabled: boolean };
export interface SettingsPort { get(uid: string): Promise<UserSettings>; set(uid: string, settings: UserSettings): Promise<UserSettings> }
export class AccountSettings implements SettingsPort {
  constructor(private db: Firestore, private existingOwner?: string) {}
  private ref(uid: string) { return this.db.doc(`users/${uid}/settings/preferences`); }
  async get(uid: string) {
    const snapshot = await this.ref(uid).get();
    return { aiTitlesEnabled: typeof snapshot.data()?.aiTitlesEnabled === "boolean" ? snapshot.data()!.aiTitlesEnabled : !!this.existingOwner && uid === this.existingOwner };
  }
  async set(uid: string, settings: UserSettings) { await this.ref(uid).set(settings); return settings; }
}
