# Plan: redc Splash + Dashboard

## Problem

red.computer needs a public-facing web presence. Instead of a static marketing page, the landing page IS the product: a read-only dashboard showing redc reviewing its own codebase. Visitors land directly in the dashboard and see the live state of the redc repo — merge velocity, review queue, change details, confidence scores, and the full change lifecycle.

This is dogfooding as marketing. The product demonstrates itself.

## Current State

- **Backend:** Hono API serving `/api/velocity`, `/api/review`, `/api/changes/:id`, `/api/jobs/pending`
- **Web app:** Vite + React + shadcn (radix-vega style) with black/red terminal theme from v0
- **Existing routes:** Dashboard (velocity cards + review queue table), Change detail page
- **Theme:** Dark-only black/red oklch theme with Geist font, already applied
- **Current root:** Shows the v0 theme demo component (temporary)

## Goal

Replace the theme demo with a production splash+dashboard that:
1. Lands the user directly on the redc dashboard (no auth, read-only)
2. Shows the live state of the redc repository being reviewed by redc itself
3. Has a minimal branded header ("red.computer") with the black/red aesthetic
4. Communicates what redc is through the dashboard itself (the product IS the explanation)

## Design Direction

- Terminal/hacker aesthetic (black background, red accents, monospace touches)
- The existing v0 theme (oklch black/red) sets the visual language
- Dense, information-rich layout — this is a tool, not a brochure
- Cards for velocity metrics, table for review queue, detail view for individual changes

## Implementation Plan

### Step 1: Clean up app structure
- Remove the Demo component from root route
- Move Dashboard back to the index route
- Keep the theme preview at `/theme` for development reference
- Remove the Layout wrapper's API-dependent pending jobs badge (or make it graceful)

### Step 2: Redesign the Dashboard as splash+dashboard
- **Hero section** at the top: "red.computer" branding + one-liner tagline explaining what redc does (e.g., "Automated code review for Forgejo. Watching itself.")
- **Velocity cards** below the hero: Merged (24h), Pending Review, with the existing API data
- **Review queue table** as the main content: repo, branch, status, confidence, source, created time
- **Change state machine visualization**: show the lifecycle (pushed → scoring → ... → merged) as a visual element, maybe in the hero or sidebar
- All data comes from the existing API endpoints, no new backend work needed

### Step 3: Polish the change detail page
- Ensure `/changes/:id` works with the black/red theme
- Show the event timeline (state transitions) in the detail view
- Show diff stats, summary, confidence score

### Step 4: Add graceful empty/error states
- When the API is down or returns no data, show meaningful states instead of blank cards
- Loading skeletons already exist, verify they work with the new theme
- Empty state for the review queue: "No changes awaiting review. The sea is calm."

### Step 5: Responsive + polish
- Ensure the dashboard looks good on mobile (stack cards, horizontal scroll for table)
- Add subtle animations (fade-in on load, status badge pulse for active items)
- Verify Geist font renders correctly across the dashboard

## Out of Scope (for now)
- Authentication / login
- Write operations (approving/rejecting changes from the UI)
- WebSocket live updates (polling is fine for v1)
- Multiple repository support in the UI
- Search / filtering on the review queue

## Tech Stack
- Vite + React 19 + React Router 7
- shadcn/ui (radix-vega style) with existing black/red theme
- Tailwind CSS v4 with oklch colors
- Existing Hono backend API (no changes needed)
