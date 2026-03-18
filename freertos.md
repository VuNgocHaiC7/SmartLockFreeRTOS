# Tài liệu Hướng dẫn Hệ điều hành nhúng thời gian thực (FreeRTOS trên Arduino)

## Chương 1: Tổng quan về Hệ điều hành thời gian thực (RTOS)

- **Khái niệm RTOS:** Là phần mềm điều khiển chuyên dụng cho các ứng dụng hệ thống nhúng có bộ nhớ hạn chế và yêu cầu nghiêm ngặt về thời gian đáp ứng. RTOS được chia làm hai loại: thời gian thực cứng (hard real-time) và thời gian thực mềm (soft real-time).
- **Thành phần cấu trúc:** Bao gồm bộ lập lịch (Scheduler), quản lý bộ nhớ, truyền thông liên tác vụ, đồng bộ, quản lý ngắt và quản lý I/O.
- **Hệ điều hành FreeRTOS:** Là hệ điều hành mã nguồn mở, kích thước nhỏ gọn, không giới hạn số lượng tác vụ và hỗ trợ nhiều nền tảng vi điều khiển (ARM, AVR, Arduino).

## Chương 2: Quản lý Tác vụ (Task) và Hàng đợi (Queue)

### Quản lý Tác vụ

- **Task là gì:** Là một luồng thực thi liên tục trong một vòng lặp vô tận độc lập, được cấp phát tài nguyên và ngăn xếp (stack) riêng.
- **4 Trạng thái của Task:**
  - _Ready:_ Đã sẵn sàng nhưng chưa chạy vì có tác vụ ưu tiên cao hơn đang chạy.
  - _Running:_ Đang chiếm quyền CPU.
  - _Blocked/Waiting:_ Đang đợi một sự kiện (ví dụ: delay hoặc đợi dữ liệu).
  - _Suspended:_ Bị đình chỉ hoàn toàn và không được lập lịch.
- **Cơ chế lập lịch:** FreeRTOS sử dụng kiểu lập lịch "thay thế mức ưu tiên cố định" (Fixed Priority Pre-emptive), kết hợp chia sẻ khe thời gian (Round-Robin) nếu các tác vụ có cùng mức ưu tiên.
- **API thông dụng:** `xTaskCreate()`, `vTaskDelete()`, `vTaskPrioritySet()`, `vTaskSuspend()`, `vTaskResume()`.

### Quản lý Hàng đợi (Queue)

- **Vai trò:** Là bộ đệm lưu trữ dữ liệu giúp các task giao tiếp với nhau theo nguyên tắc FIFO (Vào trước ra trước).
- **Cơ chế khóa Blocked:** Tác vụ muốn đọc sẽ bị khóa (Block) nếu hàng đợi rỗng và tác vụ ghi sẽ bị khóa nếu hàng đợi đầy.

## Chương 3: Đồng bộ Tác vụ và Truyền thông

- **Mục đích:** Đảm bảo tính loại trừ lẫn nhau (Mutual Exclusion), luồng dữ liệu, hoặc đồng bộ hóa các sự kiện.
- **Semaphore:**
  - _Binary Semaphore (Nhị phân):_ Hoạt động như một cờ hiệu, lý tưởng cho việc đồng bộ giữa ISR (ngắt) và Task.
  - _Counting Semaphore (Đếm):_ Dùng để đếm sự kiện xảy ra nhiều lần hoặc quản lý tập hợp tài nguyên giới hạn.
- **Mutex:** Đóng vai trò là một "Token" (chìa khóa) giúp khóa tài nguyên để tránh xung đột. Mutex dùng cơ chế **kế thừa ưu tiên (Priority Inheritance)** để sửa lỗi **đảo ngược ưu tiên (Priority Inversion)** khi một task ưu tiên thấp đang giữ tài nguyên của task ưu tiên cao.
- **Giao tiếp khác:** Sử dụng Cờ sự kiện (Event Flags) cho tín hiệu và Hộp thư/Hàng đợi cho truyền tải thông điệp (Message Passing).

## Chương 4: Quản lý Ngắt (Interrupt Management)

- **Ngắt (Interrupt):** Là sự kiện phần cứng khiến CPU dừng ngay chương trình hiện tại để chạy Chương trình phục vụ ngắt (ISR). Ngắt luôn ưu tiên cao hơn mọi Task trong RTOS.
- **Deferred Interrupt Processing:** Nguyên tắc thiết kế tối ưu là giữ cho ISR chạy càng nhanh càng tốt. ISR chỉ ra hiệu (như unblock semaphore) rồi bàn giao khối lượng công việc phức tạp cho một Task để xử lý.
- **Interrupt-safe API:** Chỉ được phép gọi các API đặc biệt dành riêng cho ngắt kết thúc bằng chữ `FromISR` (vd: `xQueueSendToBackFromISR()`) bên trong hàm ISR.

## Chương 5: Quản lý Bộ định thời (Software Timer)

- **Khái niệm:** Dùng để hẹn giờ thực thi một hàm chức năng (callback) ở một khoảng thời gian nhất định trong tương lai.
- **Phân loại:** \* _One-shot Timer:_ Chạy gọi lại callback một lần duy nhất.
  - _Auto-reload Timer:_ Tự khởi động lại để gọi callback theo định kỳ (tuần hoàn).
- **Cơ chế hoạt động:** Tất cả software timer được vận hành bởi một **Daemon Task** ngầm của hệ thống. Các lệnh thay đổi timer được truyền tới Daemon Task qua một "Timer Command Queue".
- **Nguyên tắc hàm Callback:** Callback tuyệt đối không được chứa bất kỳ API nào gây block hoặc delay (vì sẽ làm kẹt luồng của Daemon Task).

## Chương 6: Quản lý Bộ nhớ (Memory Management)

- **Kiến trúc bộ nhớ:** Trong vi điều khiển, Flash lưu trữ chương trình (ROM), SRAM để lưu trữ biến và cấp phát động, EEPROM để lưu giữ dữ liệu lâu dài.
- **5 Mô hình cấp phát Heap (Memory Schemes):**
  - _Heap_1:_ Đơn giản, an toàn nhưng không cho phép `free()` (giải phóng) tài nguyên. Phù hợp cho ứng dụng khởi tạo task 1 lần đầu.
  - _Heap_2:_ Cho phép `free()` nhưng không hợp nhất không gian trống, dễ gây phân mảnh bộ nhớ.
  - _Heap_3:_ Bao bọc hàm `malloc()` và `free()` tiêu chuẩn của C để dùng chung luồng an toàn.
  - _Heap_4:_ Nâng cấp từ Heap_2 với thuật toán tự gộp các vùng nhớ trống (coalescence) để khắc phục tình trạng phân mảnh.
  - _Heap_5:_ Tương tự Heap_4 nhưng có khả năng phân bổ heap trải dài trên nhiều phân vùng nhớ không liền kề.

## Chương 7: Giao tiếp I/O và Xử lý sự cố

- **Giao tiếp I/O:** FreeRTOS có thể dùng để quản lý truyền nhận với ngoại vi qua UART, SPI, I2C. Có 4 chế độ truyền dẫn: Polled, Zero Copy, Circular Buffer, và Character Queue.
- **Troubleshooting:** Hỗ trợ chẩn đoán các lỗi như tràn ngăn xếp (Stack underflow/overflow), lỗi gọi API ngoài giới hạn ISR, và lỗi treo bộ lập lịch do sử dụng vòng lặp vô tận không ngắt.
