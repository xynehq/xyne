import bcrypt from "bcryptjs"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Server).child({ module: "password" })

/**
 * Hash a plaintext password using bcrypt
 * @param password - The plaintext password to hash
 * @returns Promise<string> - The hashed password
 */
export async function hashPassword(password: string): Promise<string> {
  try {
    const saltRounds = 12 // High security - adjust if performance issues
    const hashedPassword = await bcrypt.hash(password, saltRounds)
    Logger.debug("Password hashed successfully")
    return hashedPassword
  } catch (error) {
    Logger.error("Error hashing password:", error)
    throw new Error("Failed to hash password")
  }
}

/**
 * Verify a plaintext password against a hashed password
 * @param password - The plaintext password to verify
 * @param hashedPassword - The hashed password to compare against
 * @returns Promise<boolean> - True if password matches, false otherwise
 */
export async function verifyPassword(
  password: string,
  hashedPassword: string,
): Promise<boolean> {
  try {
    const isMatch = await bcrypt.compare(password, hashedPassword)
    Logger.debug("Password verification completed")
    return isMatch
  } catch (error) {
    Logger.error("Error verifying password:", error)
    return false
  }
}

/**
 * Check if a password is already hashed (bcrypt format)
 * @param password - The password string to check
 * @returns boolean - True if already hashed, false if plaintext
 */
export function isPasswordHashed(password: string): boolean {
  // Bcrypt hashes start with $2a$, $2b$, $2x$, or $2y$
  return /^\$2[abxy]\$\d+\$/.test(password)
}

/**
 * Safely hash password only if it's not already hashed
 * This prevents double-hashing during migrations
 * @param password - Password that might be plaintext or already hashed
 * @returns Promise<string> - Always returns a hashed password
 */
export async function ensurePasswordHashed(password: string): Promise<string> {
  if (isPasswordHashed(password)) {
    Logger.debug("Password already hashed, skipping hash operation")
    return password
  }
  
  Logger.info("Password is plaintext, hashing now")
  return await hashPassword(password)
}

/**
 * Validate password strength
 * @param password - The password to validate
 * @returns object - Validation result with success and messages
 */
export function validatePasswordStrength(password: string): {
  isValid: boolean
  errors: string[]
} {
  const errors: string[] = []

  if (password.length < 8) {
    errors.push("Password must be at least 8 characters long")
  }

  if (!/[A-Z]/.test(password)) {
    errors.push("Password must contain at least one uppercase letter")
  }

  if (!/[a-z]/.test(password)) {
    errors.push("Password must contain at least one lowercase letter")
  }

  if (!/\d/.test(password)) {
    errors.push("Password must contain at least one number")
  }

  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
    errors.push("Password must contain at least one special character")
  }

  return {
    isValid: errors.length === 0,
    errors,
  }
}