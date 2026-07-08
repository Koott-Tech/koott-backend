require('dotenv').config();
const interaktService = require('./utils/interaktService');

async function testWA() {
  try {
    const res = await interaktService.sendRescheduleNotification('+919999999999', { // Dummy phone
      recipientName: "Test Name",
      otherPartyName: "Aswathy Sampath",
      date: "2026-07-08",
      time: "15:00:00",
      meetLink: "https://meet.google.com/test",
    });
    console.log("WA result:", res);
  } catch (e) {
    console.error("WA Error:", e);
  }
}
testWA();
