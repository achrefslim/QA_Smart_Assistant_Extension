/**
 * src/screens/popup/auth.ts
 *
 * Firebase Authentication for the popup: email/password + Google sign-in,
 * with the signed-in user cached in chrome.storage.local for per-device persistence.
 */

import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  type Auth,
  type User,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
  GoogleAuthProvider,
  signInWithCredential,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
  sendPasswordResetEmail,
  sendEmailVerification,
  reload,
} from 'firebase/auth';
import { Config } from '../../shared/config/env';

export interface QAUser {
  uid          : string;
  email        : string | null;
  displayName  : string | null;
  photoURL     : string | null;
  emailVerified: boolean;
  providerId   : string;
}

const STORAGE_KEY = 'qa_user';

let app : FirebaseApp | null = null;
let auth: Auth | null = null;

function toQAUser(user: User): QAUser {
  return {
    uid          : user.uid,
    email        : user.email,
    displayName  : user.displayName,
    photoURL     : user.photoURL,
    emailVerified: user.emailVerified,
    providerId   : user.providerData[0]?.providerId || 'password',
  };
}

/** Google accounts are already email-verified by Google — only email/password
 *  accounts need the extra verification-link step. */
export function isGoogleUser(user: QAUser): boolean {
  return user.providerId === 'google.com';
}

export function isVerified(user: QAUser | null): boolean {
  return !!user && (isGoogleUser(user) || user.emailVerified);
}

function saveUser(user: QAUser | null): Promise<void> {
  return new Promise(resolve => {
    if (user) {
      chrome.storage.local.set({ [STORAGE_KEY]: user }, () => resolve());
    } else {
      chrome.storage.local.remove(STORAGE_KEY, () => resolve());
    }
  });
}

export function getCurrentUser(): Promise<QAUser | null> {
  return new Promise(resolve => {
    chrome.storage.local.get([STORAGE_KEY], result => {
      resolve((result[STORAGE_KEY] as QAUser) || null);
    });
  });
}

export async function initAuth(): Promise<QAUser | null> {
  if (!app) {
    app  = initializeApp(Config.firebase);
    auth = getAuth(app);

    try {
      await setPersistence(auth, browserLocalPersistence);
    } catch {
      // Some extension contexts restrict IndexedDB persistence — fall back to the SDK default.
    }

    onAuthStateChanged(auth, user => {
      void saveUser(user ? toQAUser(user) : null);
    });
  }

  return getCurrentUser();
}

function ensureAuth(): Auth {
  if (!auth) throw new Error('Auth not initialized — call initAuth() first');
  return auth;
}

export async function signInWithEmail(email: string, password: string): Promise<QAUser> {
  const cred = await signInWithEmailAndPassword(ensureAuth(), email, password);
  const user = toQAUser(cred.user);
  await saveUser(user);
  return user;
}

export async function signUpWithEmail(
  email      : string,
  password   : string,
  displayName: string
): Promise<{ user: QAUser; needsVerification: boolean }> {
  const cred = await createUserWithEmailAndPassword(ensureAuth(), email, password);

  await sendEmailVerification(cred.user);

  if (displayName) {
    await updateProfile(cred.user, { displayName });
  }

  const user = toQAUser(cred.user);
  if (displayName) user.displayName = displayName;

  await saveUser(user);
  return { user, needsVerification: true };
}

/** Sends a password reset email. Throws a clean, user-facing message on failure. */
export async function sendPasswordReset(email: string): Promise<void> {
  try {
    await sendPasswordResetEmail(ensureAuth(), email);
  } catch (e) {
    const code = (e as { code?: string })?.code || '';
    const message =
      code === 'auth/invalid-email'      ? 'Enter a valid email address' :
      code === 'auth/user-not-found'     ? 'No account found with this email' :
      code === 'auth/too-many-requests'  ? 'Too many attempts. Please try again later' :
      'Could not send reset email. Please try again.';
    throw new Error(message);
  }
}

/** Resends the verification email to the currently signed-in user. */
export async function resendVerificationEmail(): Promise<void> {
  const user = ensureAuth().currentUser;
  if (!user) throw new Error('No signed-in user');
  await sendEmailVerification(user);
}

/** Refreshes the current user's emailVerified status from Firebase and re-caches it. */
export async function reloadCurrentUser(): Promise<QAUser | null> {
  const user = ensureAuth().currentUser;
  if (!user) return null;
  await reload(user);
  const qaUser = toQAUser(user);
  await saveUser(qaUser);
  return qaUser;
}

// MV3 extension popups can't use signInWithPopup/signInWithRedirect — Firebase's
// popup flow loads apis.google.com inside an iframe, which the extension's fixed
// CSP (script-src 'self') always blocks. chrome.identity.launchWebAuthFlow drives
// the OAuth exchange in a real browser-controlled window instead.
function launchGoogleAuthFlow(): Promise<string> {
  const redirectUri = chrome.identity.getRedirectURL();

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', Config.firebase.googleWebClientId);
  authUrl.searchParams.set('response_type', 'id_token');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', 'openid email profile');
  authUrl.searchParams.set('nonce', Math.random().toString(36).slice(2));
  authUrl.searchParams.set('prompt', 'select_account');

  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: authUrl.toString(), interactive: true },
      responseUrl => {
        if (chrome.runtime.lastError || !responseUrl) {
          reject(new Error(chrome.runtime.lastError?.message || 'Google sign-in was cancelled'));
          return;
        }

        const hash    = new URL(responseUrl).hash.slice(1);
        const idToken = new URLSearchParams(hash).get('id_token');

        if (!idToken) {
          reject(new Error('Google did not return an ID token'));
          return;
        }

        resolve(idToken);
      }
    );
  });
}

export async function signInWithGoogle(): Promise<QAUser> {
  try {
    const idToken   = await launchGoogleAuthFlow();
    const credential = GoogleAuthProvider.credential(idToken);
    const cred       = await signInWithCredential(ensureAuth(), credential);
    const user       = toQAUser(cred.user);
    await saveUser(user);
    return user;
  } catch (e) {
    console.error('[QA] Google sign-in failed:', e);
    throw new Error((e as Error)?.message || 'Google sign-in failed. Please try again.');
  }
}

export async function signOut(): Promise<void> {
  await firebaseSignOut(ensureAuth());
  await saveUser(null);
}
