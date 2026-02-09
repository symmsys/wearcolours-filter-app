# Shopify School Uniform Mapping App

This is a Shopify embedded admin app that allows a **single Shopify product to be mapped to multiple collections** and grades using an **external database**.

The app **does not modify Shopify product data**.
All mappings are stored externally (Supabase), making it safe to install on live stores.

## What This App Does

- Reads products from Shopify Admin
- Displays each product in an admin UI
- Allows assigning:
  - one product → multiple school collections
  - optional grade and size metadata
- Saves this mapping to an external Supabase database
- Keeps Shopify as the **source of truth**
- Does **not** update Shopify collections, tags, or product data

This is designed for school uniform businesses where:

- the same item (e.g. white shirt) is used by multiple schools
- product duplication is not acceptable

## What This App Does NOT Do

- Does not change Shopify products
- Does not create or modify Shopify collections
- Does not affect storefront behavior
- Does not require theme changes

Installing or uninstalling this app is **non-destructive**.

## High-Level Architecture

### Shopify

- Products are fetched via Admin API
- Product GID is used as the reference key
- No Shopify mutations are performed

### External Database (Supabase)

- Stores product → school → grade mappings
- Stores Shopify session data via Prisma
- Acts as an overlay data layer

## Database Schema

### `product_grade_collection`

```sql
CREATE TABLE IF NOT EXISTS public.product_grade_collection (
  id bigserial PRIMARY KEY,
  shopify_product_id text NOT NULL,
  product_title text,
  grade text,
  collection_id text,
  collection_title text,
  size_range text,
  size_type text,
  size text[] DEFAULT '{}'::text[],
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_grade_collection_product_collection_unique
    UNIQUE (shopify_product_id, collection_id)
);

CREATE INDEX IF NOT EXISTS idx_pgc_shopify_product
  ON public.product_grade_collection (shopify_product_id);

CREATE INDEX IF NOT EXISTS idx_pgc_updated_at
  ON public.product_grade_collection (updated_at DESC);

ALTER TABLE public.product_grade_collection
ADD COLUMN IF NOT EXISTS product_handle text NULL,
ADD COLUMN IF NOT EXISTS collection_handle text NULL;

-- Optional but recommended indexes
CREATE INDEX IF NOT EXISTS idx_pgc_product_handle
  ON public.product_grade_collection (product_handle);

CREATE INDEX IF NOT EXISTS idx_pgc_collection_handle
  ON public.product_grade_collection (collection_handle);
```

This table allows:

* one product → many collections(school)
* grade and size metadata per mapping

## Tech Stack

* Shopify App Framework (React Router)
* Shopify Admin GraphQL API
* Supabase (PostgreSQL)
* Prisma (Shopify session storage)
* Node.js

## Environment Variables

Create a `.env` file locally (do not commit it).

### Shopify

SHOPIFY_API_KEY=
SHOPIFY_API_SECRET=
SHOPIFY_APP_URL=
SCOPES=read_products,write_products
SESSION_SECRET=

### Supabase / Database

SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
DATABASE_URL=

`DATABASE_URL` must be a  **PostgreSQL connection string** .

It is used by Prisma to store Shopify OAuth sessions.

## Supabase Setup (Required)

This app uses  **Supabase Postgres for two purposes** :

1. Product–school–grade mapping (custom tables)
2. Shopify session storage (via Prisma)

### Step 1: Create a Supabase Project

* Go to [https://supabase.com](https://supabase.com)
* Create a new project
* Save the database password securely

---

### Step 2: Get Database Connection String

In Supabase:

* Settings → Database → Connection string (URI)

Example:

postgresql://postgres:`<password>`@db.xxxxx.supabase.co:5432/postgres

Set this value as:

<pre class="overflow-visible! px-0!" data-start="3443" data-end="3464"><div class="contain-inline-size rounded-2xl corner-superellipse/1.1 relative bg-token-sidebar-surface-primary"><div class="sticky top-[calc(var(--sticky-padding-top)+9*var(--spacing))]"><div class="absolute end-0 bottom-0 flex h-9 items-center pe-2"><div class="bg-token-bg-elevated-secondary text-token-text-secondary flex items-center gap-4 rounded-sm px-2 font-sans text-xs"></div></div></div><div class="overflow-y-auto p-4" dir="ltr"><code class="whitespace-pre!"><span><span>DATABASE_URL=
</span></span></code></div></div></pre>

in your `.env` file.

### Step 3: Create Mapping Table

Run the SQL from the **Database Schema** section above in:

* Supabase → SQL Editor

### Step 4: Run Prisma to Create Session Table

This step is  **mandatory** .

Prisma is used to store Shopify OAuth sessions.

Without this step, the app will fail to start.

Run:

<pre class="overflow-visible! px-0!" data-start="3795" data-end="3832"><div class="contain-inline-size rounded-2xl corner-superellipse/1.1 relative bg-token-sidebar-surface-primary"><div class="sticky top-[calc(var(--sticky-padding-top)+9*var(--spacing))]"><div class="absolute end-0 bottom-0 flex h-9 items-center pe-2"><div class="bg-token-bg-elevated-secondary text-token-text-secondary flex items-center gap-4 rounded-sm px-2 font-sans text-xs"></div></div></div><div class="overflow-y-auto p-4" dir="ltr"><code class="whitespace-pre! language-bash"><span><span>npx prisma migrate deploy
</span></span></code></div></div></pre>

This will create the required `Session` table in Supabase.

> You only need to run this once per database.

## Installation & Running the App

There are **two supported ways** to run this app.

## Option 1: Run with Shopify CLI (Dev Store)

Use this option if you have access to a  **Shopify dev store** .

<pre class="overflow-visible! px-0!" data-start="4149" data-end="4188"><div class="contain-inline-size rounded-2xl corner-superellipse/1.1 relative bg-token-sidebar-surface-primary"><div class="sticky top-[calc(var(--sticky-padding-top)+9*var(--spacing))]"><div class="absolute end-0 bottom-0 flex h-9 items-center pe-2"><div class="bg-token-bg-elevated-secondary text-token-text-secondary flex items-center gap-4 rounded-sm px-2 font-sans text-xs"></div></div></div><div class="overflow-y-auto p-4" dir="ltr"><code class="whitespace-pre! language-bash"><span><span>npm install
shopify app dev
</span></span></code></div></div></pre>

The Shopify CLI will:

* create a secure tunnel
* handle OAuth
* install the app on the dev store automatically

## Option 2: Run Locally Without Shopify CLI

Use this option if:

* you do not have a dev store
* you want to test against a live store
* you prefer a production-style setup

### Step 1: Install dependencies

<pre class="overflow-visible! px-0!" data-start="4515" data-end="4538"><div class="contain-inline-size rounded-2xl corner-superellipse/1.1 relative bg-token-sidebar-surface-primary"><div class="sticky top-[calc(var(--sticky-padding-top)+9*var(--spacing))]"><div class="absolute end-0 bottom-0 flex h-9 items-center pe-2"><div class="bg-token-bg-elevated-secondary text-token-text-secondary flex items-center gap-4 rounded-sm px-2 font-sans text-xs"></div></div></div><div class="overflow-y-auto p-4" dir="ltr"><code class="whitespace-pre! language-bash"><span><span>npm install
</span></span></code></div></div></pre>

### Step 2: Build the app

<pre class="overflow-visible! px-0!" data-start="4566" data-end="4591"><div class="contain-inline-size rounded-2xl corner-superellipse/1.1 relative bg-token-sidebar-surface-primary"><div class="sticky top-[calc(var(--sticky-padding-top)+9*var(--spacing))]"><div class="absolute end-0 bottom-0 flex h-9 items-center pe-2"><div class="bg-token-bg-elevated-secondary text-token-text-secondary flex items-center gap-4 rounded-sm px-2 font-sans text-xs"></div></div></div><div class="overflow-y-auto p-4" dir="ltr"><code class="whitespace-pre! language-bash"><span><span>npm run build
</span></span></code></div></div></pre>

### Step 3: Start the server

<pre class="overflow-visible! px-0!" data-start="4622" data-end="4647"><div class="contain-inline-size rounded-2xl corner-superellipse/1.1 relative bg-token-sidebar-surface-primary"><div class="sticky top-[calc(var(--sticky-padding-top)+9*var(--spacing))]"><div class="absolute end-0 bottom-0 flex h-9 items-center pe-2"><div class="bg-token-bg-elevated-secondary text-token-text-secondary flex items-center gap-4 rounded-sm px-2 font-sans text-xs"></div></div></div><div class="overflow-y-auto p-4" dir="ltr"><code class="whitespace-pre! language-bash"><span><span>npm run start
</span></span></code></div></div></pre>

### Step 4: Expose Your Local Server

Shopify requires a public HTTPS URL.

Example using Cloudflare tunnel:

<pre class="overflow-visible! px-0!" data-start="4762" data-end="4820"><div class="contain-inline-size rounded-2xl corner-superellipse/1.1 relative bg-token-sidebar-surface-primary"><div class="sticky top-[calc(var(--sticky-padding-top)+9*var(--spacing))]"><div class="absolute end-0 bottom-0 flex h-9 items-center pe-2"><div class="bg-token-bg-elevated-secondary text-token-text-secondary flex items-center gap-4 rounded-sm px-2 font-sans text-xs"></div></div></div><div class="overflow-y-auto p-4" dir="ltr"><code class="whitespace-pre! language-bash"><span><span>cloudflared tunnel --url http://localhost:3000</span></span></code></div></div></pre>

### Step 5: Configure Shopify App URLs

In  **Shopify Partner Dashboard → App setup** :

* App URL
  <pre class="overflow-visible! px-0!" data-start="4928" data-end="4960"><div class="contain-inline-size rounded-2xl corner-superellipse/1.1 relative bg-token-sidebar-surface-primary"><div class="sticky top-[calc(var(--sticky-padding-top)+9*var(--spacing))]"><div class="absolute end-0 bottom-0 flex h-9 items-center pe-2"><div class="bg-token-bg-elevated-secondary text-token-text-secondary flex items-center gap-4 rounded-sm px-2 font-sans text-xs"></div></div></div><div class="overflow-y-auto p-4" dir="ltr"><code class="whitespace-pre!"><span><span>https:</span><span>//<public-url></span><span>
  </span></span></code></div></div></pre>
* Allowed redirect URLs
  <pre class="overflow-visible! px-0!" data-start="4990" data-end="5072"><div class="contain-inline-size rounded-2xl corner-superellipse/1.1 relative bg-token-sidebar-surface-primary"><div class="sticky top-[calc(var(--sticky-padding-top)+9*var(--spacing))]"><div class="absolute end-0 bottom-0 flex h-9 items-center pe-2"><div class="bg-token-bg-elevated-secondary text-token-text-secondary flex items-center gap-4 rounded-sm px-2 font-sans text-xs"></div></div></div><div class="overflow-y-auto p-4" dir="ltr"><code class="whitespace-pre!"><span><span>https:</span><span>//</span><span><public-url></span><span>/api/au</span><span>th
  https:</span><span>//</span><span><public-url></span><span>/api/au</span><span>th/callback
  </span></span></code></div></div></pre>

Update the same URL in:

* `.env`
* `shopify.app.toml`

### Step 6: Install the App on a Store

* Go to **Partner Dashboard → Distribution**
* Use **Custom distribution**
* Generate install link
* Open the link inside the target store’s Shopify Admin

The app will appear under  **Apps** .

## Data Safety Notes

* Shopify product data is never modified
* All custom mapping data lives in Supabase
* Prisma session data is isolated
* Removing the app does not affect Shopify
* Safe to install on live stores

## Typical Usage Flow

1. Install the app
2. Open it from Shopify Admin
3. View products fetched from Shopify
4. Assign one product to multiple school collections
5. Add optional grade or size metadata
6. Save mappings to external database

## Status

This repository contains the  **initial implementation** :

* Product listing
* Multi-school mapping UI
* External data persistence
* Prisma-backed session storage
