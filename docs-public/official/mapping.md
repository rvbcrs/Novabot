# Garden Mapping Guide

!!! info "Requirements"
    App 2.3.8 with firmware v5.7.1/v0.3.6 or later.

## Step 1: Create Map

1. Click **"Start → Start mapping"** or **"Lawn"** on the homepage
2. The app automatically checks: WiFi, GPS, Bluetooth, phone battery, and Novabot battery level
3. Click the **Map** button
4. **Drag the green circle** toward the arrows to steer the robot to the lawn edge
5. The **Start button turns green** when the location is correct — click to proceed
6. The **Done button turns green** when the map is complete — click to proceed

### Options During Mapping

| Button | Action |
|--------|--------|
| **Reset** | Start mapping from the beginning |
| **Retract** | Mower backtracks automatically |

### Mapping Rules

- Maximum **3 maps** — they must be connected via channels
- Returning to the charging station is only necessary for the **first map**
- A channel is **automatically created** when the distance between lawn and charging station is greater than 1.5m
- Don't place maps too close together to prevent misidentification as passageways
- **Remapping is required** if the GNSS antenna or base is moved after initial mapping

## Step 2: Obstacles & Channels

### Creating Obstacles (No-Go Zones)

1. Click **"Obstacle"** to create a no-go area
2. The mower must be positioned on the created map (Start button turns green)
3. The **Done button turns green** when the no-go zone is complete

!!! tip "Obstacle Guidelines"
    - The mower can avoid obstacles on its own using cameras and ToF sensors
    - Remove any weeds, branches, or obstacles **longer than 20cm** from the lawn
    - Only map obstacles **greater than 1 meter**
    - Obstacle boundary must be **at least 2-3m** from the lawn map boundary
    - Obstacles can only be created after establishing two maps

### Creating Channels (Passageways)

1. Click **"Channel"** to create a passageway between two maps
2. Position the robot on the created map
3. The **Done button turns green** when the channel is complete

!!! warning "Channel Requirements"
    Channel length must be **longer than 0.5 meters** and within RTK range. Otherwise the channel cannot be used even though it can be created.

After creating three maps, click **"Finish"** to proceed.

## Step 3: Mowing

### Starting Methods

=== "Method 1: Start"
    Initiates immediate mowing.

    - **Terminate**: Full reset of mowing progress
    - **Pause**: Stops, showing completed vs. remaining areas

=== "Method 2: Lawn"
    The map appears when you click the start button. Also appears at the scheduled mowing time.

### Visual Indicators

| Color | Meaning |
|-------|---------|
| **Light green** | Area to be mowed |
| **Dark green** | Already mowed area |
| **Darker than surrounding** | Edge treatment zones (mowed 3+ times) |
| **Dotted line** | Second mowing pass (starts from beginning) |

### Inflated Boundaries

The inflated boundaries are calculated by the system according to the map created, which helps the mower record the mowing path. Due to these inflated boundaries, the mower may not move from the exact location indicated on the map.

### Edge Treatment

The mower continues mowing the area surrounding no-go zones and corners of the entire map **at least three times**, even if it appears the mower has already mowed the entire map in the app.

### Recovery Features

- The mower **repairs itself** when stopped (RTK lost) during mowing
- The mower can **continue from the last stopping point** when pressing the back button
- Use **Lawn → Add/Edit → Modify map** to remap boundaries and restart mowing

## Step 4: Scheduling

### Creating Schedules

- **Unlimited** number of schedules can be created
- Current date is displayed
- Time can be changed directly (does not reset to 8:00)
- **Minimum schedule duration: 30 minutes**

!!! warning "Schedule Behavior"
    - The mower starts automatically when a schedule is created
    - **The schedule becomes invalid if the start button is triggered manually** after creation
    - If a schedule disappears due to an error, select "retry" in the "Date" option

### Interruption Behavior

| Interruption Type | Result |
|-------------------|--------|
| **Self-caused** (charging, obstacle avoidance) | Mower resumes where it left off |
| **Manually caused** (user stops mower) | Mower restarts the entire lawn |

## Advanced Settings

!!! info
    Advanced settings can only be accessed when the mower is **online** and take effect at the **next new job start**.

| Setting | Description |
|---------|-------------|
| **Manual Controller** | Remote control with adjustable max speed. No need to carry mower back to base. |
| **Path Direction** | Select mowing angle and preview the result |
| **Obstacle Sensitivity** | Low (collision only) / Medium (ToF + camera detection) / High (ToF + camera segmentation) |
| **Maximum Speed** | Adjustable top speed |
| **Handling** | Turn speed adjustment |

!!! danger
    Do **not** activate the Manual Controller while the mower is charging — it causes constant notifications.
