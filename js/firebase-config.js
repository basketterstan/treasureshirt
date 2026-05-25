import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { getStorage } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js';

const firebaseConfig = {
  apiKey: "AIzaSyDSa4HDuZn5K21Ty1E-uFBF9IXA_Pg8Sus",
  authDomain: "treasureshirt-68b83.firebaseapp.com",
  projectId: "treasureshirt-68b83",
  storageBucket: "treasureshirt-68b83.firebasestorage.app",
  messagingSenderId: "999550128041",
  appId: "1:999550128041:web:d049592cc294c5a401beb8",
  measurementId: "G-KNFS2XXS62"
};

const app = initializeApp(firebaseConfig);
export const db      = getFirestore(app);
export const storage = getStorage(app);
