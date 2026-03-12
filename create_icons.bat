@echo off
echo 正在创建填表助手浏览器扩展所需的基本图标文件...

REM 创建一个临时的ICO文件（使用系统自带的图标）
copy "C:\Windows\System32\shell32.dll" /b + "C:\Windows\System32\imageres.dll" /b "c:\Users\zqlzq\Desktop\mix\form-filling-assistant\icons\temp.ico" 2>nul

REM 如果上面的方法不行，创建一个简单的文本文件作为占位符
if not exist "c:\Users\zqlzq\Desktop\mix\form-filling-assistant\icons\icon16.png" (
    echo. > "c:\Users\zqlzq\Desktop\mix\form-filling-assistant\icons\icon16.png"
)
if not exist "c:\Users\zqlzq\Desktop\mix\form-filling-assistant\icons\icon48.png" (
    echo. > "c:\Users\zqlzq\Desktop\mix\form-filling-assistant\icons\icon48.png"
)
if not exist "c:\Users\zqlzq\Desktop\mix\form-filling-assistant\icons\icon128.png" (
    echo. > "c:\Users\zqlzq\Desktop\mix\form-filling-assistant\icons\icon128.png"
)

echo 图标占位符文件已创建。
echo 注意：在实际部署时，您需要用真正的PNG图标文件替换这些占位符文件。
pause