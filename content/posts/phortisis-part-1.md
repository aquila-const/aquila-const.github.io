---
title: "A Different Approach to the Arduino UNO Q"
series: "Phortisis"
part: 1
date: "2026-11-25"
tags: ["zephyr","arduino-uno-q","qualcomm","stm32"]
summary: "A charging station simulated on the Arduino UNO Q: Linux on the Qualcomm chip, Zephyr on the STM32, and the Bridge between them. Part 1 maps each job to a chip, sets up Zephyr, and measures the empty-firmware baseline every later feature is compared against."
---
Hello, it has been quite some time since I last wrote an article. The past three years have been a gap to recoup and come back with a new approach. So let's dive straight into this new project.

The idea is to take a very constrained board, build something that behaves like a production product (please don't use it for production), and measure how it holds up. Every part of this series ends with numbers: flash and RAM cost per feature, latency between the two chips, and timing on the CAN bus.

> [!note] What Part 1 covers
> Which chip does what, why the microcontroller side runs Zephyr, the toolchain setup, and the first build. That first build becomes the baseline every later part is measured against.

## The board

The board is an Arduino UNO Q, the version with 4 GB of RAM and 32 GB of storage, which I was lucky to find on Tori. It has not one but *two* very different chips, and the whole series depends on keeping their jobs separate:

| | Qualcomm QRB2210 | STM32U585 |
| --- | --- | --- |
| What it is | Application processor: CPU and GPU in one package | Microcontroller (Arm Cortex-M33) |
| Runs | Debian Linux | Zephyr RTOS (this series) |
| Good at | Networking, storage, audio, anything that needs an OS | Hard real-time control, low power, predictable timing |
| In the charging station | Payments, the user session, sounds | Charger control and safety |

The two chips talk through the **Arduino Bridge**, an RPC link between the Linux side and the microcontroller. That split is the point of the project. Say a driver pays for a charging session. The payment is handled on the Linux side, and only when it succeeds does it ask the microcontroller, over the Bridge, to enable the charger. The part that switches power never has to trust a network stack, and the part that talks to the network can't switch power by itself. It's a clean separation of concerns, and it's how real chargers and vehicle systems are built.

The QRB2210's GPU supports OpenGL ES 3.1, Vulkan 1.1 and OpenCL 2.0. That will matter if a display or on-device compute comes into the project later. For now there's no display, so the GPU stays out of scope.

## Planning phase

The project is a simulated EV charging station. Here's every job it needs and the chip it belongs on:

| Job | Why the station needs it | Runs on |
| --- | --- | --- |
| Wi-Fi and Bluetooth | Payment, the user's phone, remote monitoring | QRB2210 (Linux) |
| Charger control | Turning the output on and off, enforcing limits | STM32U585 (Zephyr) |
| CAN (Controller Area Network) | Real-time charge state between the station and the "vehicle" | STM32U585, using its FDCAN controller and an external transceiver |
| Hexagon DSP | Notification sounds that go with the LED matrix. It's normally used for AI inference, but here it does audio. | QRB2210 |
| Storage (SDC2, the SD/MMC controller) | Session logs | QRB2210 |
| QUP serial engines (I2C, UART, SPI, I3C) | Sensors and peripherals on the Linux side. I3C is the faster, lower-power successor to I2C. | QRB2210 |
| GPS | Station location for the payment record | STM32U585 |
| Qwiic | A small display later on | STM32U585 |

## Yocto, or Zephyr?

At first I planned to flash a custom Yocto image onto the Qualcomm chip. Looking closer, Yocto and Zephyr don't compete here, because they belong on different chips:

- **Yocto** builds a custom embedded *Linux* image. On this board it would replace the Debian that already runs on the QRB2210. It's very configurable, but slow to rebuild, and the stock Debian already gives me Wi-Fi, Bluetooth and storage. A custom image is a project of its own, and I'll walk through one in a later series.
- **Zephyr** is a real-time operating system for microcontrollers. You choose a board, enable only the features you need through Kconfig and devicetree, and get a small firmware image with predictable timing. That's exactly what charger control needs.

So the plan is to keep Debian on the QRB2210 and run Zephyr on the STM32U585. The rest of Part 1 sets up the Zephyr side.

## Setting up Zephyr for the UNO Q

To start, install Zephyr and its SDK by following the official [Getting Started guide](https://docs.zephyrproject.org/latest/develop/getting_started/index.html). This post uses:

| | Version |
| --- | --- |
| Zephyr | 4.4.99 (development build from `main`) |
| Zephyr SDK | 1.0.1 (`arm-zephyr-eabi` toolchain) |
| Host | macOS |

Rather than activating the environment by hand in every new terminal, I added a small function to my `~/.zshrc`:

```sh
zephyr() {
    source ~/zephyrproject/.venv/bin/activate
    export ZEPHYR_BASE=~/zephyrproject/zephyr
    export ZEPHYR_SDK_INSTALL_DIR=~/zephyr-sdk-1.0.1
}
```

Running `zephyr` in a new terminal activates the Python environment that has `west` in it and tells the build where Zephyr and the SDK live. After editing `.zshrc`, open a new terminal or run `source ~/.zshrc`, or the function won't exist yet.

### The project

A Zephyr application needs very little[^1]. Here's the Phortisis base tree:

```tree
phortisis/
├── CMakeLists.txt
├── prj.conf
└── src/
    ├── main.cpp
    └── Drivers/
        ├── Bridge.h
        └── Bridge.cpp
```

- **CMakeLists.txt** pulls in Zephyr and lists the sources.
- **prj.conf** is a Kconfig fragment: the features this application turns on.
- **src/** holds the code. `Drivers/Bridge` is a placeholder for the Bridge work in Part 2.

Two optional files come up later in the series. `app.overlay` is a devicetree overlay for describing hardware, such as the CAN transceiver. `VERSION` sets the firmware version.

```cmake
cmake_minimum_required(VERSION 3.28.0)
find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(phortisis)

target_sources(app PRIVATE
    src/main.cpp
    src/Drivers/Bridge.cpp)
```

`prj.conf` has a single line, because the application is written in C++:

```sh
CONFIG_CPP=y
```

And `main.cpp` deliberately does nothing yet:

```cpp
int main()
{
    return 0;
}
```

## The first build: measuring the baseline

Zephyr builds are driven by `west`, Zephyr's meta-tool for fetching, building, flashing and debugging[^2]. You have to name the board, or the build stops and asks for one:

```sh
zephyr
west build -b arduino_uno_q
```

```output
[137/137] Linking CXX executable zephyr/zephyr.elf

Memory region         Used Size  Region Size  %age Used
           FLASH:       18724 B         2 MB      0.89%
             RAM:        4320 B       768 KB      0.55%
           SRAM0:           0 B       768 KB      0.00%
        IDT_LIST:           0 B        32 KB      0.00%

Generating files from …/Phortisis/build/zephyr/zephyr.elf for board: arduino_uno_q/stm32u585xx
```

The last line confirms the target: `arduino_uno_q/stm32u585xx`, the microcontroller side of the board.

These numbers matter more than they look. With an **empty `main()`**, the firmware is **18,724 bytes of flash** (0.89% of 2 MB) and **4,320 bytes of RAM** (0.55% of 768 KB). That's the cost of the Zephyr kernel and the board setup alone. Every feature in this series (the Bridge, CAN, charger control) is reported as a change from this baseline, so you can see exactly what each one costs.

### What utilizes the 18kb of RAM

`west build -t rom_report` breaks the flash down by file and symbol. Grouped by area:

| Area | Bytes | Share | Biggest single item |
| --- | ---: | ---: | --- |
| Drivers | 5,864 | 31.3% | UART driver, 1,984 B |
| Kernel (startup, scheduler, timeouts) | 3,210 | 17.2% | Timeouts, 756 B |
| `printf` and compiler helpers | 2,112 | 11.3% | `__l_vfprintf`, 1,154 B |
| Cortex-M architecture code | 1,884 | 10.1% | Fault handlers, 1,128 B |
| Interrupt tables | 1,368 | 7.3% | Software ISR table, 912 B |
| STM32 GPIO port setup | 936 | 5.0% | Pin configuration, 294 B |
| Not attributed to a file | 1,988 | 10.6% | |
| Everything else | 1,350 | 7.2% | Heap setup, 454 B |
| **`main.cpp`** | **4** | **0.02%** | `main()` |

(The report counts 18,716 bytes, 8 fewer than the build summary; the two tools account for a few bytes differently.)

Two things stood out. First, my own code is **4 bytes**. Everything else is the platform. Second, about **3 KB goes to printing text**, even though the application prints nothing: the UART driver, `printf`, the UART console and the boot banner are all compiled in by default. The serial console is switched on by the UNO Q's board configuration, and the boot banner and `printk` by Zephyr's own defaults. You can see all of it in `build/zephyr/.config`, the final configuration a build actually used. I'm keeping them for now, because debug output is useful and the Bridge will need a UART anyway. But they're the first place to look if flash ever gets tight.

### What utilizes the 4 KB of RAM

`west build -t ram_report` does the same for RAM, and the picture is completely different:

| Area | Bytes | Share | What it is |
| --- | ---: | ---: | --- |
| Thread stacks | 3,392 | 78.5% | Interrupt stack 2,048 B, main thread 1,024 B, idle thread 320 B |
| Thread control blocks | 384 | 8.9% | Main, idle and the scheduler's placeholder thread, 128 B each |
| Drivers | 223 | 5.2% | GPIO interrupt controller data, 128 B |
| STM32 GPIO port state | 170 | 3.9% | 16 B for each of the nine GPIO ports |
| Rest of the kernel | 106 | 2.5% | Kernel state, timeouts, time slicing |
| Everything else | 48 | 1.1% | libc, `printk`, the HAL's clock variable |

(The report counts 4,323 bytes, 3 more than the build summary, for the same reason.)

Almost four-fifths of RAM is **stack space reserved for threads**, and only one of those threads is mine. Stacks are reserved at their full size whether they're used or not, and their sizes come from Kconfig (`CONFIG_ISR_STACK_SIZE`, `CONFIG_MAIN_STACK_SIZE` and `CONFIG_IDLE_STACK_SIZE`), not from the code. Meanwhile the console code that cost about 3 KB of flash costs almost nothing in RAM.

That changes how I'll read the numbers in later parts. In flash, a feature costs its code. In RAM, it mostly costs the threads it adds, because each one brings its own stack. When the Bridge gets a thread in Part 2, I'll measure how much of its stack it actually uses with Zephyr's thread analyzer (`CONFIG_THREAD_ANALYZER`), so the stack is sized from data and not guessed.

`west` has more targets that are worth knowing early:

| Command | What it does |
| --- | --- |
| `west build -t menuconfig` | Browse and try Kconfig options interactively |
| `west build -t rom_report` | Show what uses flash, by symbol |
| `west build -t ram_report` | Show what uses RAM, by symbol |
| `west build -p always -b arduino_uno_q` | Rebuild from scratch |
| `west build -t clean` | Clean the build directory |

## Next: Part 2

Part 2 wires up the Bridge. The Linux side sends "payment accepted", the STM32 enables the (simulated) charger and replies, and then measure the round-trip latency of that exchange, both idle and with the Linux side under load. It'll also show what the Bridge adds to the 18,724-byte baseline.

[^1]: [Zephyr docs: Application Development](https://docs.zephyrproject.org/latest/develop/application/index.html)
[^2]: [Zephyr docs: West (Zephyr's meta-tool)](https://docs.zephyrproject.org/latest/develop/west/index.html#west)
