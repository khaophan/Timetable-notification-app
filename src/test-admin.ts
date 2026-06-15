import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
try {
  initializeApp();
  console.log("Admin initialized successfully");
  const db = getFirestore();
  db.collection("users").get().then((snap) => {
    console.log("Docs:", snap.docs.length);
  }).catch((e) => {
    console.error("Firestore error:", e);
  });
} catch(e) {
  console.error("Init Error:", e);
}
