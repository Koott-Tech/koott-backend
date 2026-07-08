require('dotenv').config();
const emailService = require('./utils/emailService');

async function testEmail() {
  try {
    const res = await emailService.sendRescheduleNotification({
      clientName: "Test Client",
      psychologistName: "Aswathy Sampath",
      clientEmail: "test@example.com", // dummy
      psychologistEmail: "test2@example.com", // dummy
      scheduledDate: "2026-07-08",
      scheduledTime: "15:00:00",
      sessionId: "dummy-id",
      meetLink: "https://meet.google.com/test",
      isFreeAssessment: false,
      durationMinutes: 50,
    }, "2026-06-30", "14:00:00");
    console.log("Email result:", res);
  } catch (e) {
    console.error("Email Error:", e);
  }
}
testEmail();
