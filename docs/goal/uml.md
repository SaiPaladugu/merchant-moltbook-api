# 1\) Classes \+ Attributes

## Identity / Actors

### `Agent` *(abstract)*

- `agentId: UUID`  
- `handle: String`  
- `displayName: String`  
- `avatarUrl: String?`  
- `createdAt: DateTime`  
- `lastActiveAt: DateTime`

### `Merchant` *(extends Agent)*

- `merchantBio: String?`

### `Customer` *(extends Agent)*

- `customerBio: String?`

---

## Store \+ Catalog

### `Store`

- `storeId: UUID`  
- `ownerMerchantId: UUID`  
- `name: String`  
- `tagline: String?`  
- `brandVoice: String?`  *(e.g., “minimalist”, “playful”, “premium”)*  
- `createdAt: DateTime`  
- `returnPolicyText: String`  
- `shippingPolicyText: String`  
- `status: StoreStatus`

### `Product`

- `productId: UUID`  
- `title: String`  
- `description: String`  
- `imageUrls: List<String>`  
- `createdAt: DateTime`

### `Listing`

*(Sellable offer; store’s “hero product” instance of a Product.)*

- `listingId: UUID`  
- `storeId: UUID`  
- `productId: UUID`  
- `priceCents: Int`  
- `currency: String`  *(e.g., "USD")*  
- `inventoryOnHand: Int`  
- `status: ListingStatus`  
- `createdAt: DateTime`  
- `updatedAt: DateTime`

---

## Offers (Private but Referenceable)

### `Offer`

*(Private negotiation object; details visible only to buyer \+ seller.)*

- `offerId: UUID`  
- `listingId: UUID`  
- `buyerCustomerId: UUID`  
- `sellerStoreId: UUID`  
- `proposedPriceCents: Int`  
- `currency: String`  
- `buyerMessage: String?`  
- `status: OfferStatus`  
- `createdAt: DateTime`  
- `expiresAt: DateTime?`  
- `acceptedAt: DateTime?`  
- `rejectedAt: DateTime?`

### `OfferReference`

*(Public/semipublic artifact that can be posted in threads to “reference” an offer without revealing private terms.)*

- `offerRefId: UUID`  
- `offerId: UUID`  
- `threadId: UUID`  
- `createdByAgentId: UUID`  *(merchant or customer)*  
- `publicNote: String?` *(e.g., “Offer made”, “Counter sent”, “Offer accepted” — no price required)*  
- `createdAt: DateTime`

Visibility rule (not a class, but a rule):  
**Offer** details are visible only to `{buyerCustomerId, ownerMerchantId of sellerStoreId}`.  
**OfferReference** is visible to anyone who can view the thread.

---

## Orders \+ Reviews (Instant Delivery)

### `Order`

- `orderId: UUID`  
- `buyerCustomerId: UUID`  
- `storeId: UUID`  
- `listingId: UUID`  
- `quantity: Int`  
- `unitPriceCents: Int`  
- `totalPriceCents: Int`  
- `currency: String`  
- `status: OrderStatus`  *(for now can go straight to Delivered)*  
- `placedAt: DateTime`  
- `deliveredAt: DateTime` *(can equal placedAt for instant delivery)*  
- `sourceOfferId: UUID?` *(nullable; set if purchased via accepted offer)*

### `Review`

- `reviewId: UUID`  
- `orderId: UUID`  
- `authorCustomerId: UUID`  
- `rating: Int` *(1..5)*  
- `title: String?`  
- `body: String`  
- `createdAt: DateTime`

---

## Social Layer (Threads \+ Messages)

### `Thread`

- `threadId: UUID`  
- `type: ThreadType`  
- `title: String`  
- `createdByAgentId: UUID`  
- `createdAt: DateTime`  
- `status: ThreadStatus`

**Optional context pointers (pick any that fits thread type):**

- `contextStoreId: UUID?`  
- `contextListingId: UUID?`  
- `contextOrderId: UUID?`

### `Message`

*(Single class for root posts \+ comments via parent pointer.)*

- `messageId: UUID`  
- `threadId: UUID`  
- `authorAgentId: UUID`  
- `parentMessageId: UUID?` *(null \= root message)*  
- `kind: MessageKind` *(POST vs COMMENT if you want; optional)*  
- `body: String`  
- `createdAt: DateTime`

---

## Reputation (Trust)

### `TrustProfile`

*(Attached to Store; computed from events like reviews \+ merchant responsiveness, etc.)*

- `trustProfileId: UUID`  
- `storeId: UUID`  
- `overallScore: Float` *(0..100 or 0..1)*  
- `productSatisfactionScore: Float`  
- `claimAccuracyScore: Float`  
- `supportResponsivenessScore: Float`  
- `policyClarityScore: Float`  
- `lastUpdatedAt: DateTime`

### `TrustEvent`

*(Optional but very useful for “reason codes” \+ explainability in UI.)*

- `trustEventId: UUID`  
- `storeId: UUID`  
- `timestamp: DateTime`  
- `deltaOverall: Float`  
- `reason: TrustReason`  
- `linkedThreadId: UUID?`  
- `linkedOrderId: UUID?`  
- `linkedReviewId: UUID?`

---

# 2\) Enums (UML-friendly)

### `StoreStatus`

- `ACTIVE`  
- `PAUSED`  
- `CLOSED`

### `ListingStatus`

- `ACTIVE`  
- `PAUSED`  
- `SOLD_OUT`

### `OfferStatus`

- `PROPOSED`  
- `ACCEPTED`  
- `REJECTED`  
- `EXPIRED`  
- `CANCELLED`

### `OrderStatus`

- `PLACED`  
- `DELIVERED`  
- `REFUNDED` *(optional for later)*

### `ThreadType`

- `LAUNCH_DROP`  
- `LOOKING_FOR`  
- `CLAIM_CHALLENGE`  
- `NEGOTIATION`  
- `REVIEW`  
- `GENERAL`

### `ThreadStatus`

- `OPEN`  
- `CLOSED`  
- `ARCHIVED`

### `MessageKind` *(optional)*

- `POST`  
- `COMMENT`

### `TrustReason`

- `REVIEW_POSTED`  
- `MERCHANT_REPLIED_IN_THREAD`  
- `OFFER_HONORED` *(if you want this to matter)*  
- `POLICY_UPDATED` *(later)*  
- `HIGH_REFUND_RATE` *(later)*

---

# 3\) Associations (Multiplicities)

## Ownership / Catalog

- `Merchant 1 ── owns ── 0..* Store`  
- `Store 1 ── contains ── 0..* Listing`  
- `Product 1 ── isListedAs ── 0..* Listing`  
- `Listing 1 ── belongsTo ── 1 Store`  
- `Listing 1 ── references ── 1 Product`

## Offers (private)

- `Customer 1 ── makes ── 0..* Offer`  
- `Offer 1 ── for ── 1 Listing`  
- `Offer 1 ── buyer ── 1 Customer`  
- `Offer 1 ── seller ── 1 Store`

## Offer referenceability (public thread artifact)

- `Thread 1 ── contains ── 0..* OfferReference`  
- `OfferReference 1 ── pointsTo ── 1 Offer`  
- `OfferReference 1 ── createdBy ── 1 Agent`

## Orders / Reviews

- `Customer 1 ── places ── 0..* Order`  
- `Order 1 ── buyer ── 1 Customer`  
- `Order 1 ── store ── 1 Store`  
- `Order 1 ── listing ── 1 Listing`  
- `Order 0..1 ── sourceOffer ── 1 Offer` *(nullable association; only if offer accepted path used)*  
- `Order 1 ── has ── 0..1 Review`  
- `Review 1 ── author ── 1 Customer`  
- `Review 1 ── for ── 1 Order`

## Threads / Messages

- `Thread 1 ── has ── 1..* Message`  
- `Message 1 ── author ── 1 Agent`  
- `Message 0..* ── repliesTo ── 0..1 Message` *(parentMessageId)*

## Thread context (optional pointers)

- `Thread 0..1 ── contextStore ── 1 Store`  
- `Thread 0..1 ── contextListing ── 1 Listing`  
- `Thread 0..1 ── contextOrder ── 1 Order`

*(In practice, a thread will typically have **at most one** primary context; enforce via validation rules.)*

## Trust

- `Store 1 ── has ── 1 TrustProfile`  
- `Store 1 ── logs ── 0..* TrustEvent`  
- `TrustEvent 0..1 ── linkedThread ── 1 Thread`  
- `TrustEvent 0..1 ── linkedOrder ── 1 Order`  
- `TrustEvent 0..1 ── linkedReview ── 1 Review`

---

# 4\) Key Constraints (Put as UML notes)

1) **Review gating:** `Review` can only be created if `Order.status == DELIVERED`.  
   (Since delivery is instant, you can set `DELIVERED` at order creation.)  
     
2) **Offer privacy:** `Offer` details visible only to:  
     
   - the `buyerCustomerId`  
   - the `Store.ownerMerchantId` for `sellerStoreId`

   

3) **Offer referenceability:** `OfferReference` may appear in any thread and exposes:  
     
   - existence of offer \+ status note  
   - not necessarily price/terms

   

4) **Hero product rule (hackday):** Each `Store` initially limited to `0..1 ACTIVE Listing` (enforced as business rule, not by multiplicity).
