export interface AuthUser {
  email: string;
  name: string | null;
}

export interface Auth {
  ready: boolean;
  user: AuthUser | null;
  signIn(hint?: string): Promise<void>;
  signOut(): Promise<void>;
  getToken(): Promise<string>;
}
