---
layout: ../../layouts/post.astro
title: "Building an Exchange - Part 1: Domain Primitives"
description: "Designing the foundational types behind a deterministic Python matching engine, including ticks, lots, assets, instruments, and market sides."
dateFormatted: Mar 21, 2026
tags: ["engineering", "python", "finance"]
---

Welcome to this series on how to build a financial matching engine from scratch! If you're a software engineer, you've likely interacted with financial systems, maybe even algorithmic trading APIs. You have probably placed orders, checked balances, and consumed websocket streams of market data. But what actually happens on the *inside* of an exchange? How does a venue guarantee fairness, determinism, and high throughput when thousands of bots are trying to abuse the system at the same time?

In this series, we will dissect the core mechanics of a high-performance matching engine using a deterministic, event-sourced Python architecture. We will cover everything from the basic data types and the fundamental data structures, all the way up to advanced ledger state management and event sourcing patterns.

Let's start at the very foundation of any trading system: Data Types. When dealing with other people's money, getting the foundational primitives wrong can lead to catastrophic consequences.

## The Floating Point Problem: Why Decimals Fail in Finance

The most common, and perhaps the deadliest, mistake engineers make when building their first financial application is representing prices or quantities using floating-point numbers (`float`).

Consider this classic Python example:
```python
>>> 0.1 + 0.2
0.30000000000000004
```

In a casual script, this inaccuracy is negligible. In a high-frequency trading matching engine processing millions of orders daily, these tiny fractions accumulate. That leads to phantom accounting mismatches, negative balances, database drift, and chaos when it comes time to settle trading fees or reconcile the venue's master ledger with external banking partners.

### The Problem with Python's Decimal

A natural reaction for a Python developer is to reach for the built-in `decimal.Decimal` library. `Decimal` solves the precision issue perfectly, guaranteeing exact decimal arithmetic.

```python
from decimal import Decimal

>>> Decimal('0.1') + Decimal('0.2')
Decimal('0.3')
```

However, `Decimal` comes at a major cost: **Performance**. The `Decimal` class in Python is implemented in software. While it is highly optimized, it is still fundamentally a software-based arbitrary-precision construct. It is much slower than native hardware-accelerated integer math.

In a matching engine, where latency is measured in microseconds (and in HFT environments, nanoseconds), spending CPU cycles on software-based arithmetic for every trade calculation is unacceptable. A single matching sweep might require hundreds of multiplications and additions to calculate fees, partial fills, and volume-weighted average prices. If those operations are bound by software parsing, the engine's overall throughput drops under heavy load.

### The Solution: Strictly Integers

To fix both the precision issue of floating-point representations and the performance issue of `Decimal`, professional exchanges operate strictly on **integers** (`int`). By representing all values as integers, we use the CPU's native ALU (Arithmetic Logic Unit) for fast calculations without ever losing a fraction of a penny.

But how do we represent fractions like `$0.01` or `0.0001 BTC` using whole integers? We solve this by introducing the concepts of Ticks and Lots.

## Ticks and Lots: The Granularity of the Market

Instead of arbitrary fractional numbers, exchanges define strict minimum granularities for price and quantity for every market they operate. These granularities represent the smallest possible indivisible unit.

*   **Ticks**: The minimum allowable price movement of an instrument. For example, in a traditional US Dollar stock market, the tick size might be exactly `$0.01` (1 cent). In a cryptocurrency market, the tick size might be `$0.10` or even `$0.00000001` depending on the asset's nominal value or historical volatility.
*   **Lots**: The minimum tradeable quantity of an asset. For example, you might not be allowed to buy 1 full Bitcoin, but the exchange allows you to trade in increments of `0.0001 BTC`. This increment is defined as a single lot.

When a user places an order to buy 1.5 BTC at $60,000.50, the external API gateway converts these human-readable string values into internal integer `Lots` and `Ticks` before the order ever reaches the core matching engine.

Let's look at how an exchange might enforce this at the Python type level to prevent developer errors:

```python
from dataclasses import dataclass

@dataclass(frozen=True, slots=True)
class Price:
    """Price in integer ticks."""
    ticks: int

@dataclass(frozen=True, slots=True)
class Qty:
    """Quantity in integer lots."""
    lots: int
```

By wrapping raw integers in strongly typed, immutable `dataclass` wrappers (`frozen=True`) and using `slots=True` to eliminate dictionary overhead and reduce memory footprint, the engine becomes more predictable. No developer can accidentally mix a `Price` with a `Qty`, or inject a raw `float` into a core ledger calculation, because static type checkers like `mypy` and runtime validations will immediately flag the violation as a type mismatch.

### Example: The API Gateway Translation Layer

Imagine a REST API endpoint receiving a JSON payload from a mobile trading application. The JSON wisely uses strings rather than floats to avoid generic JSON floating-point parsing errors.

```json
{
  "instrument": "BTC-USD",
  "side": "BUY",
  "price": "60000.50",
  "quantity": "1.5"
}
```

The Venue's API Gateway serves as a critical translation and validation layer. It loads the business configuration rules for the `BTC-USD` instrument.
Let's assume the configuration dictates the following:
*   `tick_size`: 0.01 USD
*   `lot_size`: 0.0001 BTC

The gateway performs the conversion into pure integers:
1.  **Price Conversion**: `60000.50 / 0.01 = 6,000,050 Ticks`
2.  **Quantity Conversion**: `1.5 / 0.0001 = 15,000 Lots`

From this point inward, the matching engine only ever sees `Price(ticks=6000050)` and `Qty(lots=15000)`. It never knows or cares about decimals again until it's time to broadcast executed trade data back out to the user frontend.

### Step Size and Minimum Notional Validation

This integer conversion trick also naturally enforces standard market rules for free:
*   **Step Size Rule**: If a user tried to place an order at an invalid increment like `$60,000.505`, the division by the `0.01` tick size would result in a fractional integer (`6000050.5`). The gateway detects this remainder and immediately rejects the order as an "Invalid Price Increment" or "Invalid Tick Size" error.
*   **Minimum Quantity / Min Notional**: Exchanges almost always have a minimum order size to prevent database spam and ensure liquidity depth (e.g., minimum 100 lots). The gateway can trivially validate this logic: `if incoming_lots < MIN_LOTS: reject("Order size too small")`.

Similarly, to prevent "fat finger" errors where a user accidentally types a billion dollars, exchanges enforce maximum quantities and maximum price deviations from the current market index, all validated cleanly at the REST edge gateway level before the engine core is burdened with the calculation.

## Core Identifiers: Who, What, and Where

With our core mathematical values safely locked down into integer variants, an engine needs to unambiguously identify the `who`, `what`, and `where` of a trade. We can use Python's `NewType` to ensure strings are semantically validated and structurally distinct while remaining lightweight. Strings are fast, map well to standard database UUID fields, and are universally serializable across programming languages.

```python
from typing import NewType

# The 'who' - Identifies the user, trader, or institutional firm placing the trade
AccountId = NewType("AccountId", str)

# The 'what' - Identifies the specific order lifecycle to track from creation to fill
OrderId = NewType("OrderId", str)

```

### Assets vs. Instruments

A fundamental concept to grasp when building exchange architecture is the distinction between an Asset and an Instrument. Many beginners confuse the two.

```python
# An Asset is an underlying currency, commodity, or token (e.g., "BTC", "USD", "EUR", "APPL").
Asset = NewType("Asset", str)
```

An Asset is a primitive unit of stored value. You hold balances of Assets in your user wallet. However, you cannot directly *trade* an Asset in isolation. You can only trade an Asset *relative to the value of another Asset*.

```python
# An Instrument is the actual trading pair composed of a base and quote Asset.
# Examples: "BTC-USD", "ETH-BTC", "APPL-USD".
Instrument = NewType("Instrument", str)
```

Every Instrument (trading pair) has two structural components:
1.  **Base Asset**: The primary asset being bought or sold (the first part of the pair name, e.g., `BTC` in `BTC-USD`). The `Qty` (Lots) parameter in an order *always* refers to the Base Asset.
2.  **Quote Asset**: The asset used to price and value the Base Asset (the second part, e.g., `USD` in `BTC-USD`). The `Price` (Ticks) parameter in an order *always* refers to the Quote Asset.

The total value of any given order or trade is known as the **Notional Value**.
`Notional Value = Quantity * Price`

If you execute a buy for 1.5 BTC (Base) at $60,000 (Quote), the Notional Value is exactly `$90,000`. This means you are receiving 1.5 BTC deposited into your Base accounting balance, and you are paying exactly $90,000 subtracted from your Quote accounting balance.

**Critical Architecture Decision:** For maximum throughput and horizontal scalability, high-performance exchanges run isolated, independent order books and matching engine instances for *every distinct Instrument*. The engine process managing `BTC-USD` does not know, care about, or share memory with the engine process managing `ETH-BTC`. This deliberate sharding allows large-scale parallel execution across multiple physical CPU cores and machines.

## The Direction of the Market: Sides

Finally, every market action on an exchange has a discrete, unambiguous direction. You are either entering the market to passively provide resting liquidity to the order book, or you are aggressively entering to take liquidity away, but in both cases you are performing one of two foundational actions: Buying or Selling.

This strict duality is best represented by an enumeration:

```python
from enum import Enum

class Side(str, Enum):
    # 'str' inheritance allows the Enum to serialize directly to "BUY" in JSON
    BUY = "BUY"
    SELL = "SELL"

    def opposite(self) -> 'Side':
        """Utility to instantly find the counterparty defensive side."""
        return Side.SELL if self == Side.BUY else Side.BUY
```

Inheriting from `str` alongside `Enum` (creating a native Python String Enum) ensures that when we eventually dump our events to a persistence database or a Kafka message bus, they naturally encode as lightweight, human-readable `"BUY"` and `"SELL"` strings rather than obscure integer state codes (like 0 and 1).

The `opposite()` method is a useful domain helper. When a large `BUY` order sweeps the limit order book and matches against a resting order, we can instantly assert that the passive resting order must be on the `opposite()` side (a `SELL` order). This simplifies validation branches and prevents bugs buried in the core algorithms.

## Summary

In this first architectural part, we have laid the groundwork for a robust, deterministic, enterprise-grade matching engine.

By strictly forbidding floating-point math and wrapping our primitive variable types in semantic containers (`Price`, `Qty`), we eliminate precision drift and hardware rounding errors. By leveraging Python's `NewType` and constrained `Enum` features, we make it much harder for future developers to cross wires between Account IDs, Order IDs, and execution directions without triggering compile-time or runtime type errors.

We have successfully constructed a deterministic and mathematically sound foundation.

In [Part 2](/post/pyvenue-part-2), we will take these primitives and use them to construct the optimized heart of the exchange: **The Limit Order Book**. We will explore how thousands of concurrent orders are organized, sorted, and prioritized with microsecond latency to ensure fair execution matching using Price-Time priority.

---

Full code can be found under:
https://github.com/cutamar/pyvenue/
