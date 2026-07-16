// uvsensord — UsageView sensor helper.
//
// Generic fallback for CPU temperature (+ per-core) via LibreHardwareMonitorLib. ASUS laptops use
// the lighter built-in ATKACPI source in UsageView instead, including their CPU/GPU fan RPM.
//
// Build (from this folder, with the two bundled DLLs alongside):
//   csc /target:winexe /platform:x64 /out:uvsensord.exe /r:LibreHardwareMonitorLib.dll /r:HidSharp.dll /r:System.Management.dll uvsensord.cs
//
// Run "uvsensord.exe --dump" once (elevated) for a one-shot diagnostic run.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;
using LibreHardwareMonitor.Hardware;

internal static class Program
{
    private sealed class UpdateVisitor : IVisitor
    {
        public void VisitComputer(IComputer computer) { computer.Traverse(this); }
        public void VisitHardware(IHardware hardware)
        {
            hardware.Update();
            foreach (var sub in hardware.SubHardware) sub.Accept(this);
        }
        public void VisitSensor(ISensor sensor) { }
        public void VisitParameter(IParameter parameter) { }
    }

    private static int Main(string[] args)
    {
        bool dump = Array.IndexOf(args, "--dump") >= 0;
        var computer = new Computer
        {
            IsCpuEnabled = true,
        };
        try { computer.Open(); }
        catch (Exception ex) { Console.Error.WriteLine("open failed: " + ex.Message); return 1; }

        var visitor = new UpdateVisitor();
        string outDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "UsageView");
        Directory.CreateDirectory(outDir);
        string outFile = Path.Combine(outDir, "sensors.json");

        while (true)
        {
            try { computer.Accept(visitor); } catch { }
            if (dump) { DumpAll(computer); computer.Close(); return 0; }
            try { AtomicWrite(outFile, BuildJson(computer)); } catch { }
            Thread.Sleep(2000);
        }
    }

    private static string BuildJson(Computer computer)
    {
        double? cpuPackage = null;
        double cpuMaxTemp = double.MinValue;
        var cores = new List<double>();
        double? cpuFan = null;
        double? gpuFan = null;

        foreach (var hw in computer.Hardware)
            Collect(hw, ref cpuPackage, ref cpuMaxTemp, cores, ref cpuFan, ref gpuFan);

        double? cpuTemp = cpuPackage ?? (cpuMaxTemp > double.MinValue ? (double?)cpuMaxTemp : null);

        var sb = new StringBuilder();
        sb.Append("{");
        sb.AppendFormat(CultureInfo.InvariantCulture, "\"ts\":{0}", DateTimeOffset.UtcNow.ToUnixTimeSeconds());
        AppendNum(sb, "cpu_temp_c", cpuTemp);
        sb.Append(",\"cpu_temp_cores\":[");
        for (int i = 0; i < cores.Count; i++)
        {
            if (i > 0) sb.Append(",");
            sb.Append(cores[i].ToString("0.0", CultureInfo.InvariantCulture));
        }
        sb.Append("]");
        AppendNum(sb, "cpu_fan_rpm", cpuFan);
        AppendNum(sb, "gpu_fan_rpm", gpuFan);
        sb.Append("}");
        return sb.ToString();
    }

    private static void Collect(IHardware hw, ref double? cpuPackage, ref double cpuMaxTemp, List<double> cores, ref double? cpuFan, ref double? gpuFan)
    {
        bool isCpu = hw.HardwareType == HardwareType.Cpu;
        bool isGpu = hw.HardwareType == HardwareType.GpuNvidia
            || hw.HardwareType == HardwareType.GpuAmd
            || hw.HardwareType == HardwareType.GpuIntel;

        foreach (var s in hw.Sensors)
        {
            if (!s.Value.HasValue) continue;
            double v = s.Value.Value;

            if (s.SensorType == SensorType.Temperature && isCpu)
            {
                if (s.Name.IndexOf("Package", StringComparison.OrdinalIgnoreCase) >= 0) cpuPackage = v;
                else if (s.Name.IndexOf("Core", StringComparison.OrdinalIgnoreCase) >= 0
                         && s.Name.IndexOf("Max", StringComparison.OrdinalIgnoreCase) < 0
                         && s.Name.IndexOf("Distance", StringComparison.OrdinalIgnoreCase) < 0)
                    cores.Add(v);
                if (v > cpuMaxTemp) cpuMaxTemp = v;
            }
            else if (s.SensorType == SensorType.Fan && v > 0)
            {
                if (isGpu) { if (!gpuFan.HasValue || v > gpuFan.Value) gpuFan = v; }
                else { if (!cpuFan.HasValue || v > cpuFan.Value) cpuFan = v; }
            }
        }

        foreach (var sub in hw.SubHardware)
            Collect(sub, ref cpuPackage, ref cpuMaxTemp, cores, ref cpuFan, ref gpuFan);
    }

    private static void AppendNum(StringBuilder sb, string key, double? value)
    {
        sb.Append(",\"").Append(key).Append("\":");
        if (value.HasValue) sb.Append(value.Value.ToString("0.0", CultureInfo.InvariantCulture));
        else sb.Append("null");
    }

    private static void AtomicWrite(string path, string content)
    {
        string tmp = path + ".tmp";
        File.WriteAllText(tmp, content, new UTF8Encoding(false));
        if (File.Exists(path)) File.Delete(path);
        File.Move(tmp, path);
    }

    private static void DumpAll(Computer computer)
    {
        foreach (var hw in computer.Hardware) DumpHardware(hw, 0);
    }

    private static void DumpHardware(IHardware hw, int depth)
    {
        string pad = new string(' ', depth * 2);
        Console.WriteLine(pad + "[" + hw.HardwareType + "] " + hw.Name);
        foreach (var s in hw.Sensors)
            Console.WriteLine(pad + "  - " + s.SensorType + " / " + s.Name + " = " + (s.Value.HasValue ? s.Value.Value.ToString("0.0", CultureInfo.InvariantCulture) : "null"));
        foreach (var sub in hw.SubHardware) DumpHardware(sub, depth + 1);
    }
}
