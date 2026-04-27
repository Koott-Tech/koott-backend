const { sessionTypeFromBooking, sessionCountFromBooking } = require('./utils/wixBookingMapper');

// 1. Mock Niya Joseph Package (The one where math failed)
const niyaPackage = {
  title: "Niya Joseph",
  rawBookedEntity: { title: "Niya Joseph", rate: { defaultVariedPrice: { amount: "749" } } },
  paymentDetails: { balance: { finalPrice: { amount: "2499" } } },
  // Let's simulate if it had a variant or plan name
  variantSelections: "Package of 4 Sessions" 
};

// 2. Mock Couple Session
const coupleSession = {
  title: "Fathima Hiba",
  variantSelections: "Couple Session (1699 INR)",
  paymentDetails: { balance: { finalPrice: { amount: "1699" } } }
};

// 3. Mock Assessment
const assessment = {
  title: "Discovery Session - Child Assessment",
  paymentDetails: { balance: { finalPrice: { amount: "1500" } } }
};

console.log('\n--- NEW DETECTION LOGIC TEST ---');

const testCases = [
  { name: "Niya Package (Text Detected)", data: niyaPackage },
  { name: "Couple Session", data: coupleSession },
  { name: "Assessment", data: assessment }
];

testCases.forEach(tc => {
  const type = sessionTypeFromBooking(tc.data);
  const count = sessionCountFromBooking(tc.data);
  console.log(`Test: ${tc.name.padEnd(25)} | Type: ${type.padEnd(12)} | Count: ${count}`);
});

console.log('-------------------------------\n');
