const admin = require('firebase-admin');
const fs = require('fs');

async function testAdmin() {
  try {
    const config = JSON.parse(fs.readFileSync('./firebase-applet-config.json', 'utf8'));
    admin.initializeApp();
    const db = admin.firestore();
    db.settings({
      ignoreUndefinedProperties: true,
      databaseId: config.firestoreDatabaseId
    });
    const snapshot = await db.collection('test').limit(1).get();
    console.log("Admin SDK initialized and queried successfully.");
  } catch (err) {
    console.error("Admin SDK failed:", err);
  }
}

testAdmin();
