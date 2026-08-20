import SwiftUI

struct ContentView: View {
    @State private var name = "Ada"

    var body: some View {
        VStack {
            Text("Welcome, \(name)!")
            Button("Continue") { }
            Button("Cancel") { }
            Text(NSLocalizedString("settings.title", comment: ""))
        }
    }
}
