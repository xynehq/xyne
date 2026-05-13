// Test file for workflow verification
// This file is used to verify CodeRabbit and GitHub Actions workflows

interface UserData {
  id: number;
  name: string;
  email: string;
  role: string;
}

/**
 * Process user data and return formatted string
 * @param user - The user data object
 * @returns Formatted user string
 */
function processUserData(user: UserData): string {
  if (!user) {
    throw new Error("User data is required");
  }
  
  const { id, name, email, role } = user;
  
  // Validate required fields
  if (!id || !name || !email) {
    console.warn("Missing required fields in user data");
    return "";
  }
  
  return `User: ${name} (ID: ${id}) - ${email} [${role || "no role"}]`;
}

/**
 * Calculate sum of array elements
 * @param numbers - Array of numbers
 * @returns Sum of all numbers
 */
function calculateSum(numbers: number[]): number {
  let sum = 0;
  for (let i = 0; i < numbers.length; i++) {
    sum += numbers[i];
  }
  return sum;
}

// Export for testing
export { processUserData, calculateSum, type UserData };
