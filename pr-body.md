## Summary
Fixes an infinite redirect loop that occurs when accessing the login page with an invalid or expired authentication token.

## Root Cause
The `useEffect` hook in App.tsx calls `checkAuth()` on every page load, including the login page. When an invalid token exists in localStorage:
1. `checkAuth()` calls `getMe()` which fails with 401
2. `apiFetch()` handles 401 by redirecting to `/login`
3. This creates an infinite redirect loop

## Fix
Skip the auth check when the current pathname is `/login` to prevent the circular redirect.

## Testing
- Access `/login` with no valid token - page should load without redirect loop
- Login should work normally
- Protected routes should still require authentication
