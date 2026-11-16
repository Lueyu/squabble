/**
 * @file types/common.ts
 * @description Shared application-level TypeScript types.
 *
 * Holds generic domain shapes (user profile, file attachments) and augments
 * the global `Window` interface with runtime-injected auth fields. Portfolio-
 * specific records are typically inferred inline from the API responses in
 * `api/index.ts` rather than re-declared here.
 */

/**
 * Lifecycle status of a user account.
 */
enum IUserStatus {
  /** Account is active and can sign in. */
  active = 1,
  /** Account is disabled/inactive. */
  inactive = 2,
}

/**
 * Profile metadata for the currently authenticated user.
 */
export type IUserProfile = {
  /** Primary user id. */
  user_id: string;
  /** Login email address. */
  email: string;
  /** Display name. */
  name: string;
  /** URL of the avatar image. */
  avatar: string;
  /** Account lifecycle status. */
  status: IUserStatus;
};

/**
 * Reference to a file stored in the object-storage bucket.
 */
export type IFileAttachment = {
  /** Bucket the file lives in. */
  bucket_id: string;
  /** Path/key of the file inside the bucket. */
  file_path: string;
};
