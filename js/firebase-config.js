import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getFirestore }  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { getAuth, setPersistence, browserLocalPersistence } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getStorage } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js';

// Firebase web API keys are public client identifiers — security is enforced by
// the Firestore and Storage security rules (firestore.rules, storage.rules).
export const firebaseConfig = {
  apiKey: "AIzaSyDSa4HDuZn5K21Ty1E-uFBF9IXA_Pg8Sus",
  authDomain: "treasureshirt-68b83.firebaseapp.com",
  projectId: "treasureshirt-68b83",
  storageBucket: "treasureshirt-68b83.firebasestorage.app",
  messagingSenderId: "730624863800",
  appId: "1:730624863800:web:3c4f5c7ae3e8b62b4f7c9d"
};

export const app     = initializeApp(firebaseConfig);
export const db      = getFirestore(app);
export const auth    = getAuth(app);
export const storage = getStorage(app);
setPersistence(auth, browserLocalPersistence);
